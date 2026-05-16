import { RingBuffer } from '../utils/RingBuffer.js'
import { SLUG_PREFIX } from '../types/market.js'
import type { MarketSymbol } from '../types/market.js'
import type {
  OraclePriceEvent,
  ActivityTradeEvent,
  ClobBestBidAskEvent,
  ClobPriceChangeEvent,
  ClobLastTradeEvent,
  ClobBookEvent,
  WhaleAlertEvent,
  MarketTickEvent,
  MarketWindowOpenEvent,
} from '../types/events.js'

// ── Raw history entries ───────────────────────────────────────────────────────

export interface OracleTick   { price: number; ts: number }
export interface QuoteTick    { bid: number; ask: number; mid: number; spread: number; ts: number }
export interface TradeTick    { side: 'BUY' | 'SELL'; sizeUsd: number; ts: number }
export interface WhaleTick    { side: 'BUY' | 'SELL'; sizeUsd: number; ts: number }

// ── Per-symbol state ──────────────────────────────────────────────────────────

export interface SymbolStore {
  // Rolling history — sized to cover max lookback (5 min)
  oracleHistory: RingBuffer<OracleTick>   // ~1/sec → cap 300
  quoteHistory:  RingBuffer<QuoteTick>    // ~2/sec → cap 600
  tradeHistory:  RingBuffer<TradeTick>    // sparse  → cap 500
  whaleHistory:  RingBuffer<WhaleTick>    // rare    → cap 50

  // Window timing (updated by market.tick)
  windowTs:       number
  closeTs:        number
  nowSec:         number
}

function makeSymbolStore(): SymbolStore {
  return {
    oracleHistory: new RingBuffer(300),
    quoteHistory:  new RingBuffer(600),
    tradeHistory:  new RingBuffer(500),
    whaleHistory:  new RingBuffer(50),
    windowTs:      0,
    closeTs:       0,
    nowSec:        0,
  }
}

// ── FeatureStore ──────────────────────────────────────────────────────────────

export class FeatureStore {
  readonly symbols: Record<MarketSymbol, SymbolStore> = {
    BTC: makeSymbolStore(),
    ETH: makeSymbolStore(),
    SOL: makeSymbolStore(),
  }

  // tokenId → { symbol, outcome } — updated on market.windowOpen
  private tokenMap = new Map<string, { symbol: MarketSymbol; outcome: 'up' | 'down' }>()

  // ── Update methods (called by SignalEngine bus listeners) ─────────────────

  updateOracle(e: OraclePriceEvent): void {
    this.symbols[e.symbol].oracleHistory.push({ price: e.price, ts: e.ts })
  }

  updateTrade(e: ActivityTradeEvent): void {
    const sym = this.slugToSymbol(e.eventSlug)
    if (!sym) return
    const sizeUsd = e.sizeShares * e.price
    this.symbols[sym].tradeHistory.push({
      side:    e.side,
      sizeUsd,
      ts:      e.ts * 1000,   // ActivityTradeEvent.ts is Unix seconds → convert to ms
    })
  }

  updateBestBidAsk(e: ClobBestBidAskEvent): void {
    const tok = this.tokenMap.get(e.tokenId)
    if (!tok) return
    const mid = (e.bid + e.ask) / 2
    this.symbols[tok.symbol].quoteHistory.push({
      bid: e.bid, ask: e.ask, mid, spread: e.ask - e.bid, ts: e.ts,
    })
  }

  updatePriceChange(e: ClobPriceChangeEvent): void {
    const tok = this.tokenMap.get(e.tokenId)
    if (!tok) return
    const mid = (e.bestBid + e.bestAsk) / 2
    this.symbols[tok.symbol].quoteHistory.push({
      bid: e.bestBid, ask: e.bestAsk, mid, spread: e.bestAsk - e.bestBid, ts: e.ts,
    })
  }

  updateBook(e: ClobBookEvent): void {
    const tok = this.tokenMap.get(e.tokenId)
    if (!tok) return
    const bid = e.bids[0]?.price
    const ask = e.asks[0]?.price
    if (bid == null || ask == null) return
    const mid = (bid + ask) / 2
    this.symbols[tok.symbol].quoteHistory.push({
      bid, ask, mid, spread: ask - bid, ts: e.ts,
    })
  }

  updateWhale(e: WhaleAlertEvent): void {
    const sym = e.trade.symbol
    this.symbols[sym].whaleHistory.push({
      side:    e.trade.side,
      sizeUsd: e.trade.sizeUsd,
      ts:      e.trade.ts * 1000,   // WhaleTrade.ts is Unix seconds
    })
  }

  updateClock(e: MarketTickEvent): void {
    for (const sym of ['BTC', 'ETH', 'SOL'] as const) {
      const s = this.symbols[sym]
      s.windowTs = e.window.windowTs
      s.closeTs  = e.window.closeTs
      s.nowSec   = e.nowSec
    }
  }

  resetWindow(e: MarketWindowOpenEvent): void {
    // Rebuild token map
    this.tokenMap.clear()
    for (const [sym, ids] of Object.entries(e.tokenIds) as [MarketSymbol, { up: string | null; down: string | null }][]) {
      if (ids.up)   this.tokenMap.set(ids.up,   { symbol: sym, outcome: 'up' })
      if (ids.down) this.tokenMap.set(ids.down, { symbol: sym, outcome: 'down' })
    }

    // Update window timestamps for each symbol
    for (const sym of ['BTC', 'ETH', 'SOL'] as const) {
      this.symbols[sym].windowTs = e.windowTs
      this.symbols[sym].closeTs  = e.closeTs
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private slugToSymbol(slug: string): MarketSymbol | null {
    for (const [sym, prefix] of Object.entries(SLUG_PREFIX) as [MarketSymbol, string][]) {
      if (slug.startsWith(prefix)) return sym
    }
    return null
  }
}
