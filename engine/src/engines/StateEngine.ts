import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { SYMBOLS, makeInitialState } from '../types/market.js'
import type { MarketSymbol, GlobalState, SymbolState, WhaleTrade } from '../types/market.js'
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
} from '../types/events.js'
import type { ClobClient } from '../ws/clob/ClobClient.js'

const WHALE_THRESHOLD_USD = Number(process.env['WHALE_THRESHOLD'] ?? 10_000)
const WHALE_RETENTION_SECONDS = 60

// Maps CLOB token IDs → which symbol+outcome they belong to
type TokenMap = Map<string, { symbol: MarketSymbol; outcome: 'up' | 'down' }>

export class StateEngine {
  private state: GlobalState = makeInitialState()
  private tokenMap: TokenMap = new Map()
  private clobClient: ClobClient

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient
  }

  start(): void {
    log.info('[State] starting state engine')
    bus.on('oracle.price', (e) => this.onOraclePrice(e))
    bus.on('trade.activity', (e) => this.onTradeActivity(e))
    bus.on('clob.bestBidAsk', (e) => this.onBestBidAsk(e))
    bus.on('clob.priceChange', (e) => this.onPriceChange(e))
    bus.on('clob.lastTrade', (e) => this.onLastTrade(e))
    bus.on('clob.book', (e) => this.onBook(e))
    bus.on('market.tick', (e) => this.onMarketTick(e))
    bus.on('market.windowOpen', (e) => this.onWindowOpen(e))
    bus.on('connection.change', (e) => this.onConnectionChange(e))
  }

  getState(): Readonly<GlobalState> {
    return this.state
  }

  private emit(): void {
    bus.emit('state.snapshot', { state: this.deepClone(this.state) })
  }

  private onOraclePrice(e: OraclePriceEvent): void {
    const sym = this.state.symbols[e.symbol]
    sym.oraclePrice = e.price
    sym.oraclePriceTs = e.ts

    // Track direction vs open price
    if (sym.openPrice !== null) {
      if (e.price > sym.openPrice) sym.priceDirection = 'up'
      else if (e.price < sym.openPrice) sym.priceDirection = 'down'
      else sym.priceDirection = 'flat'
    }

    this.emit()
  }

  private onTradeActivity(e: ActivityTradeEvent): void {
    // Determine which symbol this trade belongs to via slug parsing
    const sym = this.symbolFromSlug(e.eventSlug)
    if (!sym) return

    const sizeUsd = e.sizeShares * e.price  // shares × price ≈ USD cost

    // Orderflow delta: buys positive, sells negative
    this.state.symbols[sym].orderflowDelta +=
      e.side === 'BUY' ? sizeUsd : -sizeUsd

    // Whale detection
    if (sizeUsd >= WHALE_THRESHOLD_USD) {
      const whale: WhaleTrade = {
        wallet: e.wallet,
        side: e.side,
        sizeUsd,
        price: e.price,
        symbol: sym,
        outcome: e.outcome,
        ts: e.ts,
      }
      this.state.symbols[sym].recentWhales.push(whale)
      bus.emit('whale.alert', { trade: whale })
      log.info(`[State] 🐋 ${sym} ${e.side} $${sizeUsd.toFixed(0)} (${e.outcome}) ${e.wallet.slice(0, 8)}…`)
    }

    this.pruneWhales(sym)
    this.emit()
  }

  private onBestBidAsk(e: ClobBestBidAskEvent): void {
    const entry = this.tokenMap.get(e.tokenId)
    if (!entry || entry.outcome !== 'up') return  // Only track UP token odds as proxy
    const sym = this.state.symbols[entry.symbol]
    sym.bestBid = e.bid
    sym.bestAsk = e.ask
    sym.spread = e.ask - e.bid
    this.emit()
  }

  private onPriceChange(e: ClobPriceChangeEvent): void {
    const entry = this.tokenMap.get(e.tokenId)
    if (!entry || entry.outcome !== 'up') return
    const sym = this.state.symbols[entry.symbol]
    sym.bestBid = e.bestBid
    sym.bestAsk = e.bestAsk
    sym.spread = e.bestAsk - e.bestBid
    this.emit()
  }

  private onLastTrade(e: ClobLastTradeEvent): void {
    const entry = this.tokenMap.get(e.tokenId)
    if (!entry || entry.outcome !== 'up') return
    this.state.symbols[entry.symbol].lastTradePrice = e.price
    this.emit()
  }

  private onBook(e: ClobBookEvent): void {
    const entry = this.tokenMap.get(e.tokenId)
    if (!entry || entry.outcome !== 'up') return
    const sym = this.state.symbols[entry.symbol]
    const topBid = e.bids[0]?.price ?? null
    const topAsk = e.asks[0]?.price ?? null
    sym.bestBid = topBid
    sym.bestAsk = topAsk
    sym.spread = topBid !== null && topAsk !== null ? topAsk - topBid : null
    this.emit()
  }

  private onMarketTick(e: MarketTickEvent): void {
    this.state.window = e.window
    this.pruneAllWhales()
    this.emit()
  }

  private onWindowOpen(e: MarketWindowOpenEvent): void {
    log.info('[State] new window — resetting per-window state')

    // Reset per-window fields for all symbols
    for (const sym of SYMBOLS) {
      const s = this.state.symbols[sym]
      const currentPrice = s.oraclePrice

      s.openPrice = currentPrice          // Lock oracle price as opening reference
      s.priceDirection = null
      s.orderflowDelta = 0
      s.recentWhales = []
      s.bestBid = null
      s.bestAsk = null
      s.spread = null
      s.lastTradePrice = null
      s.tokenIds = e.tokenIds[sym]
    }

    // Rebuild token map
    this.tokenMap.clear()
    for (const sym of SYMBOLS) {
      const ids = e.tokenIds[sym]
      if (ids.up) this.tokenMap.set(ids.up, { symbol: sym, outcome: 'up' })
      if (ids.down) this.tokenMap.set(ids.down, { symbol: sym, outcome: 'down' })
    }

    // Tell CLOB client which token IDs to subscribe to
    const allTokenIds = [...this.tokenMap.keys()]
    this.clobClient.updateSubscriptions(allTokenIds)

    this.emit()
  }

  private onConnectionChange(e: ConnectionEvent): void {
    if (e.service === 'rtds') this.state.connections.rtds = e.status
    if (e.service === 'clob') this.state.connections.clob = e.status
    this.emit()
  }

  private symbolFromSlug(slug: string): MarketSymbol | null {
    if (slug.startsWith('btc-')) return 'BTC'
    if (slug.startsWith('eth-')) return 'ETH'
    if (slug.startsWith('sol-')) return 'SOL'
    return null
  }

  private pruneWhales(sym: MarketSymbol): void {
    const cutoff = Math.floor(Date.now() / 1000) - WHALE_RETENTION_SECONDS
    this.state.symbols[sym].recentWhales =
      this.state.symbols[sym].recentWhales.filter((w) => w.ts >= cutoff)
  }

  private pruneAllWhales(): void {
    for (const sym of SYMBOLS) this.pruneWhales(sym)
  }

  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T
  }
}
