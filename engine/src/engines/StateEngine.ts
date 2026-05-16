import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { SYMBOLS, makeInitialState } from '../types/market'
import type { MarketSymbol, GlobalState, SymbolState, WhaleTrade } from '../types/market'
import type {
  OraclePriceEvent,
  ActivityTradeEvent,
  ClobBestBidAskEvent,
  ClobPriceChangeEvent,
  ClobLastTradeEvent,
  ClobBookEvent,
  MarketTickEvent,
  MarketWindowOpenEvent,
  ConnectionEvent,
} from '../types/events'
import type { ClobClient } from '../ws/clob/ClobClient'
import { hashState } from '../utils/stateHash'

const WHALE_THRESHOLD_USD   = Number(process.env['WHALE_THRESHOLD'] ?? 10_000)
const WHALE_RETENTION_SECS  = 60

type TokenMap = Map<string, { symbol: MarketSymbol; outcome: 'up' | 'down' }>

export class StateEngine {
  private state: GlobalState = makeInitialState()
  private tokenMap: TokenMap = new Map()
  private clobClient: ClobClient
  private mutationCount = 0

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient
  }

  start(): void {
    log.info('[State] starting state engine')
    bus.on('oracle.price',    (e) => this.onOraclePrice(e))
    bus.on('trade.activity',  (e) => this.onTradeActivity(e))
    bus.on('clob.bestBidAsk', (e) => this.onBestBidAsk(e))
    bus.on('clob.priceChange',(e) => this.onPriceChange(e))
    bus.on('clob.lastTrade',  (e) => this.onLastTrade(e))
    bus.on('clob.book',       (e) => this.onBook(e))
    bus.on('market.tick',     (e) => this.onMarketTick(e))
    bus.on('market.windowOpen',(e) => this.onWindowOpen(e))
    bus.on('connection.change',(e) => this.onConnectionChange(e))
  }

  getState(): Readonly<GlobalState> {
    return this.state
  }

  getMutationCount(): number {
    return this.mutationCount
  }

  getStateHash(): string {
    return hashState(this.state)
  }

  private emit(): void {
    this.mutationCount++
    const clone = this.deepClone(this.state)

    // Shallow-freeze key sub-objects so any listener that accidentally
    // mutates a snapshot field gets a runtime TypeError.
    Object.freeze(clone.connections)
    Object.freeze(clone.window)
    for (const sym of SYMBOLS) {
      // Freeze the whale array too (array itself, not elements)
      Object.freeze(clone.symbols[sym].recentWhales)
      Object.freeze(clone.symbols[sym].tokenIds)
      Object.freeze(clone.symbols[sym])
    }
    Object.freeze(clone.symbols)
    Object.freeze(clone)

    bus.emit('state.snapshot', { state: clone })
  }

  // ── Oracle ───────────────────────────────────────────────────────────────────

  private onOraclePrice(e: OraclePriceEvent): void {
    const sym = this.state.symbols[e.symbol]
    sym.oraclePrice   = e.price
    sym.oraclePriceTs = e.ts

    if (sym.openPrice !== null) {
      if (e.price > sym.openPrice)      sym.priceDirection = 'up'
      else if (e.price < sym.openPrice) sym.priceDirection = 'down'
      else                              sym.priceDirection = 'flat'
    }

    this.emit()
  }

  // ── Activity trades ──────────────────────────────────────────────────────────

  private onTradeActivity(e: ActivityTradeEvent): void {
    const sym = this.symbolFromSlug(e.eventSlug)
    if (!sym) return

    const sizeUsd = e.sizeShares * e.price

    this.state.symbols[sym].orderflowDelta +=
      e.side === 'BUY' ? sizeUsd : -sizeUsd

    if (sizeUsd >= WHALE_THRESHOLD_USD) {
      const whale: WhaleTrade = {
        wallet:  e.wallet,
        side:    e.side,
        sizeUsd,
        price:   e.price,
        symbol:  sym,
        outcome: e.outcome,
        ts:      e.ts,
      }
      this.state.symbols[sym].recentWhales.push(whale)
      bus.emit('whale.alert', { trade: whale })
      log.info(`[State] whale ${sym} ${e.side} $${sizeUsd.toFixed(0)} (${e.outcome}) ${e.wallet.slice(0, 8)}…`)
    }

    this.pruneWhales(sym)
    this.emit()
  }

  // ── CLOB ─────────────────────────────────────────────────────────────────────

  private onBestBidAsk(e: ClobBestBidAskEvent): void {
    const entry = this.tokenMap.get(e.tokenId)
    if (!entry || entry.outcome !== 'up') return
    const sym   = this.state.symbols[entry.symbol]
    sym.bestBid = e.bid
    sym.bestAsk = e.ask
    sym.spread  = e.ask - e.bid
    this.emit()
  }

  private onPriceChange(e: ClobPriceChangeEvent): void {
    const entry = this.tokenMap.get(e.tokenId)
    if (!entry || entry.outcome !== 'up') return
    const sym   = this.state.symbols[entry.symbol]
    sym.bestBid = e.bestBid
    sym.bestAsk = e.bestAsk
    sym.spread  = e.bestAsk - e.bestBid
    this.emit()
  }

  private onLastTrade(e: ClobLastTradeEvent): void {
    const entry = this.tokenMap.get(e.tokenId)
    if (!entry || entry.outcome !== 'up') return
    this.state.symbols[entry.symbol].lastTradePrice = e.price
    this.emit()
  }

  private onBook(e: ClobBookEvent): void {
    const entry  = this.tokenMap.get(e.tokenId)
    if (!entry || entry.outcome !== 'up') return
    const sym    = this.state.symbols[entry.symbol]
    const topBid = e.bids[0]?.price ?? null
    const topAsk = e.asks[0]?.price ?? null
    sym.bestBid  = topBid
    sym.bestAsk  = topAsk
    sym.spread   = topBid !== null && topAsk !== null ? topAsk - topBid : null
    this.emit()
  }

  // ── Market clock ─────────────────────────────────────────────────────────────

  private onMarketTick(e: MarketTickEvent): void {
    this.state.window = e.window
    // Use e.nowSec (logical clock) for pruning — ensures deterministic replay
    this.pruneAllWhales(e.nowSec)
    this.emit()
  }

  private onWindowOpen(e: MarketWindowOpenEvent): void {
    // Log closing window checksum BEFORE resetting (useful for replay verification)
    const closingHash = hashState(this.state)
    log.info(
      `[State] window ${this.state.window.windowTs} closed` +
      ` | hash:${closingHash}` +
      ` | mutations:${this.mutationCount}`
    )

    log.info(`[State] opening window ${e.windowTs} → ${e.closeTs}`)

    for (const sym of SYMBOLS) {
      const s            = this.state.symbols[sym]
      const currentPrice = s.oraclePrice

      if (currentPrice !== null) {
        log.info(`[State] ${sym} open price: ${currentPrice} (oracle age: ${
          s.oraclePriceTs ? `${((Date.now() - s.oraclePriceTs) / 1000).toFixed(1)}s` : 'unknown'
        })`)
      } else {
        log.warn(`[State] ${sym} open price: NULL — no oracle data at window open`)
      }

      s.openPrice       = currentPrice
      s.priceDirection  = null
      s.orderflowDelta  = 0
      s.recentWhales    = []
      s.bestBid         = null
      s.bestAsk         = null
      s.spread          = null
      s.lastTradePrice  = null
      s.tokenIds        = e.tokenIds[sym]
    }

    // Rebuild token map
    this.tokenMap.clear()
    for (const sym of SYMBOLS) {
      const ids = e.tokenIds[sym]
      if (ids.up)   this.tokenMap.set(ids.up,   { symbol: sym, outcome: 'up' })
      if (ids.down) this.tokenMap.set(ids.down, { symbol: sym, outcome: 'down' })
    }

    log.info(`[State] token map rebuilt (${this.tokenMap.size} entries)`)

    const allTokenIds = [...this.tokenMap.keys()]
    this.clobClient.updateSubscriptions(allTokenIds)

    this.emit()
  }

  // ── Connection ───────────────────────────────────────────────────────────────

  private onConnectionChange(e: ConnectionEvent): void {
    if (e.service === 'rtds') {
      this.state.connections.rtds = e.status
    }

    if (e.service === 'clob') {
      this.state.connections.clob = e.status

      // Invalidate stale orderbook data immediately on CLOB disconnect.
      // The terminal will show "─" instead of values that may be minutes old.
      // Fresh book snapshots will repopulate on reconnect.
      if (e.status === 'reconnecting') {
        log.info('[State] CLOB reconnecting — invalidating stale orderbook data')
        for (const sym of SYMBOLS) {
          const s        = this.state.symbols[sym]
          s.bestBid      = null
          s.bestAsk      = null
          s.spread       = null
          s.lastTradePrice = null
        }
      }
    }

    this.emit()
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private symbolFromSlug(slug: string): MarketSymbol | null {
    if (slug.startsWith('btc-')) return 'BTC'
    if (slug.startsWith('eth-')) return 'ETH'
    if (slug.startsWith('sol-')) return 'SOL'
    return null
  }

  private pruneWhales(sym: MarketSymbol, nowSec?: number): void {
    const now    = nowSec ?? Math.floor(Date.now() / 1000)
    const cutoff = now - WHALE_RETENTION_SECS
    this.state.symbols[sym].recentWhales =
      this.state.symbols[sym].recentWhales.filter((w) => w.ts >= cutoff)
  }

  private pruneAllWhales(nowSec?: number): void {
    for (const sym of SYMBOLS) this.pruneWhales(sym, nowSec)
  }

  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T
  }
}
