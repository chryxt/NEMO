/**
 * Order matching against synthetic orderbooks.
 *
 * Conservative assumptions (realism > optimism):
 *   - Market BUYs pay best-ask side (never assume mid-fill)
 *   - Walks the book level-by-level when size > top-of-book depth
 *   - Slippage is attributed to spread cost vs depth cost vs latency adverse selection
 *   - No fill emitted when no quote exists at arrival time
 */
import { config } from '../config/index'
import type { OrderBook } from './OrderBook'
import type { SimOrder, SimFill, OrderState } from './types'

export interface FillResult {
  fills:    SimFill[]
  newState: OrderState
  reason?:  string
}

const NO_FILL_KEEP: FillResult = { fills: [], newState: 'OPEN' }

export class FillEngine {
  private readonly takerFeeBps: number

  constructor() {
    this.takerFeeBps = config.simTakerFeeBps
  }

  // ── Public entry point ────────────────────────────────────────────────────

  evaluate(order: SimOrder, book: OrderBook, nowMs: number): FillResult {
    // Not yet arrived at exchange
    if (nowMs < order.tsArrival) return { fills: [], newState: 'PENDING' }

    // Expired
    if (order.expiryMs != null && nowMs >= order.expiryMs) {
      return { fills: [], newState: 'EXPIRED', reason: 'expired' }
    }

    // No liquidity yet
    if (!book.hasLiquidity()) {
      return order.type === 'LIMIT'
        ? NO_FILL_KEEP
        : { fills: [], newState: 'CANCELLED', reason: 'no liquidity' }
    }

    switch (order.type) {
      case 'MARKET': return this.fillMarket(order, book, nowMs)
      case 'IOC':    return this.fillIOC(order, book, nowMs)
      case 'FOK':    return this.fillFOK(order, book, nowMs)
      case 'LIMIT':  return this.fillLimit(order, book, nowMs)
    }
  }

  // ── MARKET: walk the book to fill maxSize ─────────────────────────────────

  private fillMarket(order: SimOrder, book: OrderBook, nowMs: number): FillResult {
    const remaining = order.size - order.filledSize
    const result = order.side === 'BUY'
      ? book.consumeAsks(remaining, 1.0)
      : book.consumeBids(remaining, 0.0)

    if (result.filled === 0) {
      return { fills: [], newState: 'CANCELLED', reason: 'no fillable liquidity' }
    }

    const mid          = book.getMid()
    const bestQuote    = order.side === 'BUY' ? book.getBestAsk()?.price : book.getBestBid()?.price
    const midAtSubmit  = order.midAtSubmit ?? mid ?? result.avgPrice

    const fee = (result.cost * this.takerFeeBps) / 10_000
    const slip = midAtSubmit > 0 ? ((result.avgPrice - midAtSubmit) / midAtSubmit) * 10_000 : 0
    const spreadCost = mid && mid > 0 ? ((result.avgPrice - mid) / mid) * 10_000 : 0
    const depthCost = bestQuote && bestQuote > 0 ? ((result.avgPrice - bestQuote) / bestQuote) * 10_000 : 0

    const fill: SimFill = {
      orderId:       order.id,
      ts:            nowMs,
      symbol:        order.symbol,
      outcome:       order.outcome,
      side:          order.side,
      price:         result.avgPrice,
      size:          result.filled,
      fee,
      slippageBps:   order.side === 'BUY' ? slip : -slip,
      spreadCostBps: order.side === 'BUY' ? spreadCost : -spreadCost,
      depthCostBps:  order.side === 'BUY' ? depthCost  : -depthCost,
    }

    const totalFilled = order.filledSize + result.filled
    const newState: OrderState = totalFilled >= order.size - 1e-9 ? 'FILLED' : 'CANCELLED'

    return { fills: [fill], newState }
  }

  // ── IOC: take whatever's available at limit price or better, cancel rest ──

  private fillIOC(order: SimOrder, book: OrderBook, nowMs: number): FillResult {
    if (order.limitPrice == null) return { fills: [], newState: 'REJECTED', reason: 'IOC requires limit price' }

    const remaining = order.size - order.filledSize
    const result = order.side === 'BUY'
      ? book.consumeAsks(remaining, order.limitPrice)
      : book.consumeBids(remaining, order.limitPrice)

    if (result.filled === 0) {
      return { fills: [], newState: 'CANCELLED', reason: 'no fillable liquidity at limit' }
    }

    const mid         = book.getMid()
    const bestQuote   = order.side === 'BUY' ? book.getBestAsk()?.price : book.getBestBid()?.price
    const midAtSubmit = order.midAtSubmit ?? mid ?? result.avgPrice
    const fee = (result.cost * this.takerFeeBps) / 10_000
    const slip = midAtSubmit > 0 ? ((result.avgPrice - midAtSubmit) / midAtSubmit) * 10_000 : 0
    const spreadCost = mid && mid > 0 ? ((result.avgPrice - mid) / mid) * 10_000 : 0
    const depthCost = bestQuote && bestQuote > 0 ? ((result.avgPrice - bestQuote) / bestQuote) * 10_000 : 0

    const fill: SimFill = {
      orderId:       order.id,
      ts:            nowMs,
      symbol:        order.symbol,
      outcome:       order.outcome,
      side:          order.side,
      price:         result.avgPrice,
      size:          result.filled,
      fee,
      slippageBps:   order.side === 'BUY' ? slip : -slip,
      spreadCostBps: order.side === 'BUY' ? spreadCost : -spreadCost,
      depthCostBps:  order.side === 'BUY' ? depthCost  : -depthCost,
    }

    const totalFilled = order.filledSize + result.filled
    const newState: OrderState = totalFilled >= order.size - 1e-9 ? 'FILLED' : 'CANCELLED'
    return { fills: [fill], newState }
  }

  // ── FOK: all-or-nothing at limit price or better ──────────────────────────

  private fillFOK(order: SimOrder, book: OrderBook, nowMs: number): FillResult {
    if (order.limitPrice == null) return { fills: [], newState: 'REJECTED', reason: 'FOK requires limit price' }

    const remaining = order.size - order.filledSize
    const result = order.side === 'BUY'
      ? book.consumeAsks(remaining, order.limitPrice)
      : book.consumeBids(remaining, order.limitPrice)

    if (result.filled < remaining - 1e-9) {
      // Cannot fill in full → cancel without partial
      return { fills: [], newState: 'CANCELLED', reason: 'FOK: insufficient liquidity at limit' }
    }

    const mid         = book.getMid()
    const bestQuote   = order.side === 'BUY' ? book.getBestAsk()?.price : book.getBestBid()?.price
    const midAtSubmit = order.midAtSubmit ?? mid ?? result.avgPrice
    const fee = (result.cost * this.takerFeeBps) / 10_000
    const slip = midAtSubmit > 0 ? ((result.avgPrice - midAtSubmit) / midAtSubmit) * 10_000 : 0
    const spreadCost = mid && mid > 0 ? ((result.avgPrice - mid) / mid) * 10_000 : 0
    const depthCost = bestQuote && bestQuote > 0 ? ((result.avgPrice - bestQuote) / bestQuote) * 10_000 : 0

    const fill: SimFill = {
      orderId:       order.id,
      ts:            nowMs,
      symbol:        order.symbol,
      outcome:       order.outcome,
      side:          order.side,
      price:         result.avgPrice,
      size:          result.filled,
      fee,
      slippageBps:   order.side === 'BUY' ? slip : -slip,
      spreadCostBps: order.side === 'BUY' ? spreadCost : -spreadCost,
      depthCostBps:  order.side === 'BUY' ? depthCost  : -depthCost,
    }
    return { fills: [fill], newState: 'FILLED' }
  }

  // ── LIMIT: passive resting order; fills when crossed ──────────────────────

  private fillLimit(order: SimOrder, book: OrderBook, nowMs: number): FillResult {
    if (order.limitPrice == null) return { fills: [], newState: 'REJECTED', reason: 'LIMIT requires limit price' }

    // Cross check
    if (order.side === 'BUY') {
      const ask = book.getBestAsk()
      if (!ask || ask.price > order.limitPrice) return NO_FILL_KEEP
      // Crossed: fill at the limit price or better (take at ask)
      const result = book.consumeAsks(order.size - order.filledSize, order.limitPrice)
      if (result.filled === 0) return NO_FILL_KEEP

      const mid       = book.getMid()
      const midAtSub  = order.midAtSubmit ?? mid ?? result.avgPrice
      const fee = (result.cost * this.takerFeeBps) / 10_000
      const slip = midAtSub > 0 ? ((result.avgPrice - midAtSub) / midAtSub) * 10_000 : 0

      const fill: SimFill = {
        orderId: order.id, ts: nowMs,
        symbol:  order.symbol, outcome: order.outcome, side: 'BUY',
        price:   result.avgPrice, size: result.filled, fee,
        slippageBps:   slip,
        spreadCostBps: mid ? ((result.avgPrice - mid) / mid) * 10_000 : 0,
        depthCostBps:  ((result.avgPrice - ask.price) / ask.price) * 10_000,
      }
      const totalFilled = order.filledSize + result.filled
      return { fills: [fill], newState: totalFilled >= order.size - 1e-9 ? 'FILLED' : 'OPEN' }
    } else {
      const bid = book.getBestBid()
      if (!bid || bid.price < order.limitPrice) return NO_FILL_KEEP
      const result = book.consumeBids(order.size - order.filledSize, order.limitPrice)
      if (result.filled === 0) return NO_FILL_KEEP

      const mid      = book.getMid()
      const midAtSub = order.midAtSubmit ?? mid ?? result.avgPrice
      const fee = (result.cost * this.takerFeeBps) / 10_000
      const slip = midAtSub > 0 ? ((result.avgPrice - midAtSub) / midAtSub) * 10_000 : 0

      const fill: SimFill = {
        orderId: order.id, ts: nowMs,
        symbol:  order.symbol, outcome: order.outcome, side: 'SELL',
        price:   result.avgPrice, size: result.filled, fee,
        slippageBps:   -slip,
        spreadCostBps: mid ? -((result.avgPrice - mid) / mid) * 10_000 : 0,
        depthCostBps:  -((result.avgPrice - bid.price) / bid.price) * 10_000,
      }
      const totalFilled = order.filledSize + result.filled
      return { fills: [fill], newState: totalFilled >= order.size - 1e-9 ? 'FILLED' : 'OPEN' }
    }
  }
}
