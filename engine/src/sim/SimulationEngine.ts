/**
 * Paper trading orchestrator.
 *
 * Subscribes to bus events, maintains per-tokenId orderbooks, drives strategies,
 * applies latency, evaluates fills, and tracks portfolio state.
 *
 * Logical time:
 *   The engine uses event timestamps (oracle.price.ts, clob.*.ts, etc.) as
 *   "now" — never wall-clock Date.now(). This guarantees deterministic
 *   behavior under replay.
 */
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'
import { OrderBook } from './OrderBook.js'
import { LatencyModel } from './LatencyModel.js'
import { Portfolio } from './Portfolio.js'
import { RiskManager } from './RiskManager.js'
import { FillEngine } from './FillEngine.js'
import { SYMBOLS } from '../types/market.js'
import type { MarketSymbol } from '../types/market.js'
import type {
  OrderRequest, SimOrder, SimFill, Outcome, OrderState,
} from './types.js'
import type { SignalFrame } from '../signals/types.js'
import type { Strategy } from '../strategies/Strategy.js'

interface TokenMeta { symbol: MarketSymbol; outcome: Outcome }

export class SimulationEngine {
  private readonly portfolio: Portfolio
  private readonly latency:   LatencyModel
  private readonly fills:     FillEngine
  private readonly risk:      RiskManager
  private readonly strategies: Strategy[]

  private readonly books = new Map<string, OrderBook>()   // tokenId → book
  private readonly tokenMap = new Map<string, TokenMeta>() // tokenId → meta
  private readonly openOrders: SimOrder[] = []

  // Snapshot of latest features per symbol for risk checks
  private readonly latestFrame = new Map<MarketSymbol, SignalFrame>()

  // Track window data for settlement
  private readonly windowOpenPrices = new Map<string, number>()  // `${sym}:${windowTs}` → price
  private readonly latestOraclePrice = new Map<MarketSymbol, number>()
  private currentWindowTs = 0
  private nowMs = 0

  private orderCounter = 0
  private submitted    = 0
  private filled       = 0
  private cancelled    = 0
  private rejected     = 0

  constructor(latency: LatencyModel, strategies: Strategy[]) {
    this.portfolio   = new Portfolio(config.simStartingCash)
    this.latency     = latency
    this.fills       = new FillEngine()
    this.risk        = new RiskManager()
    this.strategies  = strategies
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    bus.on('clob.book',        (e) => this.applyBookSnapshot(e.tokenId, e))
    bus.on('clob.priceChange', (e) => this.applyPriceChange(e.tokenId, e))
    bus.on('clob.bestBidAsk',  (e) => this.applyBba(e.tokenId, e))
    bus.on('clob.lastTrade',   (e) => this.applyLastTrade(e.tokenId, e))

    bus.on('oracle.price', (e) => {
      this.nowMs = e.ts
      this.latestOraclePrice.set(e.symbol, e.price)
      this.markPositions(e.symbol)
      this.processOpenOrders()
    })

    bus.on('market.tick',       (e) => { this.nowMs = e.nowSec * 1000; this.processOpenOrders() })
    bus.on('market.windowOpen', (e) => this.onWindowOpen(e.windowTs, e.tokenIds))
    bus.on('signal.frame',      ({ frame }) => this.onSignal(frame))
    bus.on('whale.alert',       (e) => this.onWhaleAlert(e))

    log.info(`[SimulationEngine] started — cash=$${config.simStartingCash}  latency=${this.latency.describe()}  strategies=[${this.strategies.map(s => s.name).join(', ')}]`)
  }

  stop(): void {
    // Close all open positions at last mark price (graceful end-of-replay)
    this.portfolio.forceCloseAllAtMark(this.nowMs)
    log.info('[SimulationEngine] stopped', this.summary())
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  private applyBookSnapshot(tokenId: string, e: import('../types/events.js').ClobBookEvent): void {
    this.getOrCreateBook(tokenId).applyBookSnapshot(e)
    this.nowMs = e.ts
    this.processOpenOrders()
  }

  private applyPriceChange(tokenId: string, e: import('../types/events.js').ClobPriceChangeEvent): void {
    this.getOrCreateBook(tokenId).applyPriceChange(e)
    this.nowMs = e.ts
    this.processOpenOrders()
  }

  private applyBba(tokenId: string, e: import('../types/events.js').ClobBestBidAskEvent): void {
    this.getOrCreateBook(tokenId).applyBestBidAsk(e)
    this.nowMs = e.ts
    this.processOpenOrders()
  }

  private applyLastTrade(tokenId: string, e: import('../types/events.js').ClobLastTradeEvent): void {
    this.getOrCreateBook(tokenId).applyLastTrade(e)
    this.nowMs = e.ts
    this.processOpenOrders()
  }

  private onWindowOpen(windowTs: number, tokenIds: Record<MarketSymbol, { up: string | null; down: string | null }>): void {
    // Settle the previous window before rebuilding state
    if (this.currentWindowTs > 0 && this.currentWindowTs !== windowTs) {
      this.settleWindow(this.currentWindowTs)
    }

    this.currentWindowTs = windowTs
    this.tokenMap.clear()

    // Rebuild tokenMap and reset books
    for (const sym of SYMBOLS) {
      const ids = tokenIds[sym]
      if (ids.up)   this.tokenMap.set(ids.up,   { symbol: sym, outcome: 'up'   })
      if (ids.down) this.tokenMap.set(ids.down, { symbol: sym, outcome: 'down' })

      // Record opening oracle price for this window
      const openPrice = this.latestOraclePrice.get(sym)
      if (openPrice != null) {
        this.windowOpenPrices.set(`${sym}:${windowTs}`, openPrice)
      }
    }

    // Reset books for new tokens (no stale state from previous window)
    for (const id of this.tokenMap.keys()) {
      this.books.set(id, new OrderBook())
    }

    log.debug(`[SimulationEngine] window opened ts=${windowTs}  tokens=${this.tokenMap.size}`)
  }

  private settleWindow(windowTs: number): void {
    const outcomes = new Map<MarketSymbol, Outcome>()

    for (const sym of SYMBOLS) {
      const openPrice = this.windowOpenPrices.get(`${sym}:${windowTs}`)
      const closePrice = this.latestOraclePrice.get(sym)
      if (openPrice == null || closePrice == null) continue

      // Polymarket binary: up wins if close > open, down wins otherwise
      outcomes.set(sym, closePrice > openPrice ? 'up' : 'down')
    }

    this.portfolio.settleWindow(windowTs, outcomes, this.nowMs)
    this.risk.onPositionClosed(this.portfolio, this.nowMs)

    log.info(`[SimulationEngine] settled window ${windowTs}`, {
      outcomes: Object.fromEntries(outcomes),
      ...this.summary(),
    })
  }

  private onSignal(frame: SignalFrame): void {
    this.latestFrame.set(frame.symbol, frame)
    this.nowMs = frame.ts

    for (const strategy of this.strategies) {
      const request = strategy.onSignal(frame, this.portfolio, this.nowMs)
      if (request) this.submitOrder(request, frame)
    }
  }

  private onWhaleAlert(e: import('../types/events.js').WhaleAlertEvent): void {
    this.nowMs = e.trade.ts * 1000  // WhaleTrade.ts is Unix seconds
    for (const strategy of this.strategies) {
      if (!strategy.onWhaleAlert) continue
      const request = strategy.onWhaleAlert(e, this.portfolio, this.nowMs)
      if (request) {
        const frame = this.latestFrame.get(e.trade.symbol)
        this.submitOrder(request, frame ?? null)
      }
    }
  }

  // ── Order submission & processing ─────────────────────────────────────────

  private submitOrder(request: OrderRequest, frame: SignalFrame | null): void {
    const decision = this.risk.canSubmit(request, this.portfolio, this.nowMs, frame?.features ?? null)
    if (!decision.ok) {
      this.rejected++
      log.debug(`[Sim] REJECTED ${request.symbol} ${request.outcome} ${request.side} ${request.size}: ${decision.reason}`)
      return
    }

    const tokenId = this.findTokenId(request.symbol, request.outcome)
    if (!tokenId) {
      this.rejected++
      log.debug(`[Sim] REJECTED ${request.symbol} ${request.outcome}: no tokenId (window not yet open?)`)
      return
    }

    const book = this.books.get(tokenId)
    const midAtSubmit = book?.getMid() ?? null

    const order: SimOrder = {
      id:           `sim-${++this.orderCounter}`,
      strategyId:   request.strategyId,
      symbol:       request.symbol,
      outcome:      request.outcome,
      side:         request.side,
      type:         request.type,
      size:         request.size,
      limitPrice:   request.limitPrice ?? null,
      state:        'PENDING',
      tsSubmit:     this.nowMs,
      tsArrival:    this.latency.arrivalTime(this.nowMs),
      tsFill:       null,
      expiryMs:     request.expiryMs != null ? this.nowMs + request.expiryMs : null,
      filledSize:   0,
      avgFillPrice: null,
      midAtSubmit,
      reason:       request.reason,
      windowTs:     this.currentWindowTs,
      rejectReason: null,
    }

    this.submitted++
    this.openOrders.push(order)
    log.debug(`[Sim] SUBMIT ${order.id} ${order.symbol} ${order.outcome} ${order.side} ${order.size} ${order.type}@${order.limitPrice ?? 'mkt'} — ${order.reason}`)

    // Immediately try to process (handles 0-latency configurations)
    this.processOpenOrders()
  }

  private processOpenOrders(): void {
    if (this.openOrders.length === 0) return

    const keep: SimOrder[] = []
    for (const order of this.openOrders) {
      const tokenId = this.findTokenId(order.symbol, order.outcome)
      if (!tokenId) { keep.push(order); continue }

      const book = this.books.get(tokenId)
      if (!book) { keep.push(order); continue }

      const result = this.fills.evaluate(order, book, this.nowMs)

      if (result.fills.length > 0) {
        for (const fill of result.fills) {
          order.filledSize += fill.size
          order.avgFillPrice = order.avgFillPrice == null
            ? fill.price
            : (order.avgFillPrice * (order.filledSize - fill.size) + fill.price * fill.size) / order.filledSize
          order.tsFill = fill.ts
          this.portfolio.applyFill(order, fill)
        }
      }

      order.state = result.newState
      if (result.reason && (order.state === 'CANCELLED' || order.state === 'EXPIRED' || order.state === 'REJECTED')) {
        order.rejectReason = result.reason
      }

      switch (order.state) {
        case 'FILLED':
          this.filled++
          log.debug(`[Sim] FILLED ${order.id} avg=${order.avgFillPrice?.toFixed(4)}  size=${order.filledSize}`)
          break
        case 'CANCELLED':
        case 'EXPIRED':
        case 'REJECTED':
          this.cancelled++
          log.debug(`[Sim] ${order.state} ${order.id}: ${order.rejectReason}`)
          break
        case 'OPEN':
        case 'PENDING':
        case 'PARTIAL':
          keep.push(order)
          break
      }
    }
    this.openOrders.length = 0
    this.openOrders.push(...keep)
  }

  private markPositions(symbol: MarketSymbol): void {
    // Use book mid for each outcome
    for (const outcome of ['up', 'down'] as Outcome[]) {
      const tokenId = this.findTokenId(symbol, outcome)
      if (!tokenId) continue
      const book = this.books.get(tokenId)
      const mid = book?.getMid()
      if (mid == null) continue
      this.portfolio.markPosition(symbol, outcome, this.currentWindowTs, mid, this.nowMs)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getOrCreateBook(tokenId: string): OrderBook {
    let book = this.books.get(tokenId)
    if (!book) {
      book = new OrderBook()
      this.books.set(tokenId, book)
    }
    return book
  }

  private findTokenId(symbol: MarketSymbol, outcome: Outcome): string | null {
    for (const [id, meta] of this.tokenMap) {
      if (meta.symbol === symbol && meta.outcome === outcome) return id
    }
    return null
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getPortfolio(): Portfolio { return this.portfolio }

  getSummaryCounts() {
    return { submitted: this.submitted, filled: this.filled, cancelled: this.cancelled, rejected: this.rejected }
  }

  // ── Kill-switch passthrough (Phase 6) ─────────────────────────────────────
  triggerKillSwitch(reason: string): void { this.risk.triggerKill(reason) }
  resetKillSwitch():           void { this.risk.resetKill() }
  isKillSwitchActive():        boolean { return this.risk.isKillSwitchActive() }
  getKillSwitchReason():       string { return this.risk.getKillReason() }

  summary(): Record<string, unknown> {
    const s = this.portfolio.snapshot(this.risk.isKillSwitchActive())
    return {
      submitted:     this.submitted,
      filled:        this.filled,
      cancelled:     this.cancelled,
      rejected:      this.rejected,
      cash:          `$${s.cash.toFixed(2)}`,
      equity:        `$${s.totalEquity.toFixed(2)}`,
      pnl:           `$${(s.totalEquity - s.startCash).toFixed(2)}`,
      drawdown:      `${(s.drawdown * 100).toFixed(2)}%`,
      winRate:       `${(s.winRate * 100).toFixed(1)}%`,
      openPositions: s.openPositions,
      closedTrades:  s.closedTrades,
      killSwitch:    s.killSwitchActive,
    }
  }
}
