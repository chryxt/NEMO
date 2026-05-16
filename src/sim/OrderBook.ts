/**
 * Synthetic per-token orderbook reconstructed from CLOB events.
 *
 * - clob.book        → full snapshot, replaces current state
 * - clob.priceChange → decrements size at a level (trade occurred there)
 * - clob.bestBidAsk  → seeds top-of-book if no book snapshot has arrived
 *
 * When only top-of-book is known (no full snapshot yet), we use a conservative
 * default-depth assumption. This keeps fills realistic but slightly pessimistic
 * about available liquidity.
 */
import type {
  ClobBookEvent,
  ClobPriceChangeEvent,
  ClobBestBidAskEvent,
  ClobLastTradeEvent,
} from '../types/events.js'

const DEFAULT_TOP_OF_BOOK_DEPTH = 1_000  // shares assumed at top when only BBA is known

export interface BookLevel {
  price: number
  size:  number
}

export interface ConsumeResult {
  filled:   number              // shares filled
  cost:     number              // total $ cost (size × price summed across levels)
  avgPrice: number              // cost / filled
  levels:   BookLevel[]         // levels consumed (price/size pairs)
}

export class OrderBook {
  private bids = new Map<number, number>()  // price → size, descending iteration desired
  private asks = new Map<number, number>()  // price → size, ascending iteration desired
  private hasSnapshot = false
  lastUpdateTs = 0

  applyBookSnapshot(e: ClobBookEvent): void {
    this.bids.clear()
    this.asks.clear()
    for (const b of e.bids) if (b.size > 0) this.bids.set(b.price, b.size)
    for (const a of e.asks) if (a.size > 0) this.asks.set(a.price, a.size)
    this.hasSnapshot  = true
    this.lastUpdateTs = e.ts
  }

  applyPriceChange(e: ClobPriceChangeEvent): void {
    // BUY trade ate liquidity from the ask side at e.price
    // SELL trade ate liquidity from the bid side at e.price
    const map = e.side === 'BUY' ? this.asks : this.bids
    const existing = map.get(e.price)
    if (existing != null) {
      const newSize = existing - e.size
      if (newSize <= 0) map.delete(e.price)
      else              map.set(e.price, newSize)
    }
    // Update best bid/ask if changed
    this.updateBestFromEvent(e.bestBid, e.bestAsk)
    this.lastUpdateTs = e.ts
  }

  applyBestBidAsk(e: ClobBestBidAskEvent): void {
    if (!this.hasSnapshot) {
      // Seed top-of-book with conservative depth
      this.bids.set(e.bid, DEFAULT_TOP_OF_BOOK_DEPTH)
      this.asks.set(e.ask, DEFAULT_TOP_OF_BOOK_DEPTH)
    } else {
      this.updateBestFromEvent(e.bid, e.ask)
    }
    this.lastUpdateTs = e.ts
  }

  applyLastTrade(e: ClobLastTradeEvent): void {
    // Remove consumed liquidity from the corresponding side
    const map = e.side === 'BUY' ? this.asks : this.bids
    const existing = map.get(e.price)
    if (existing != null) {
      const newSize = existing - e.size
      if (newSize <= 0) map.delete(e.price)
      else              map.set(e.price, newSize)
    }
    this.lastUpdateTs = e.ts
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getBestBid(): BookLevel | null {
    if (this.bids.size === 0) return null
    let best = -Infinity, size = 0
    for (const [price, sz] of this.bids) {
      if (price > best) { best = price; size = sz }
    }
    return { price: best, size }
  }

  getBestAsk(): BookLevel | null {
    if (this.asks.size === 0) return null
    let best = Infinity, size = 0
    for (const [price, sz] of this.asks) {
      if (price < best) { best = price; size = sz }
    }
    return { price: best, size }
  }

  getMid(): number | null {
    const bid = this.getBestBid()
    const ask = this.getBestAsk()
    if (!bid || !ask) return null
    return (bid.price + ask.price) / 2
  }

  hasLiquidity(): boolean {
    return this.bids.size > 0 && this.asks.size > 0
  }

  // ── Fill simulation ────────────────────────────────────────────────────────

  // Simulate a market BUY: walk asks ascending, fill up to maxSize at limitPrice or better.
  consumeAsks(maxSize: number, limitPrice = 1.0): ConsumeResult {
    const sorted = [...this.asks.entries()].sort((a, b) => a[0] - b[0])
    let remaining = maxSize
    let cost      = 0
    let filled    = 0
    const levels: BookLevel[] = []

    for (const [price, size] of sorted) {
      if (remaining <= 0) break
      if (price > limitPrice) break
      const take = Math.min(remaining, size)
      cost     += take * price
      filled   += take
      remaining -= take
      levels.push({ price, size: take })
    }

    return { filled, cost, avgPrice: filled > 0 ? cost / filled : 0, levels }
  }

  // Simulate a market SELL: walk bids descending, fill up to maxSize at limitPrice or better.
  consumeBids(maxSize: number, limitPrice = 0.0): ConsumeResult {
    const sorted = [...this.bids.entries()].sort((a, b) => b[0] - a[0])
    let remaining = maxSize
    let cost      = 0
    let filled    = 0
    const levels: BookLevel[] = []

    for (const [price, size] of sorted) {
      if (remaining <= 0) break
      if (price < limitPrice) break
      const take = Math.min(remaining, size)
      cost     += take * price
      filled   += take
      remaining -= take
      levels.push({ price, size: take })
    }

    return { filled, cost, avgPrice: filled > 0 ? cost / filled : 0, levels }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private updateBestFromEvent(newBid: number, newAsk: number): void {
    if (!this.hasSnapshot) return  // bbox snapshot will populate when available

    // Trim bid levels above newBid (they're stale)
    for (const [p] of this.bids) {
      if (p > newBid) this.bids.delete(p)
    }
    if (!this.bids.has(newBid)) this.bids.set(newBid, DEFAULT_TOP_OF_BOOK_DEPTH)

    // Trim ask levels below newAsk
    for (const [p] of this.asks) {
      if (p < newAsk) this.asks.delete(p)
    }
    if (!this.asks.has(newAsk)) this.asks.set(newAsk, DEFAULT_TOP_OF_BOOK_DEPTH)
  }
}
