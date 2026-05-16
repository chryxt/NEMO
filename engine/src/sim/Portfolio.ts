/**
 * Position and PnL accounting for paper trading on Polymarket binary outcomes.
 *
 * Position key: `${symbol}:${outcome}:${windowTs}`
 *   - One position per (symbol, outcome, window). Different windows are
 *     independent — Up/Down tokens reset at each 5-min boundary.
 *
 * Settlement:
 *   At window close, the position pays $1/share if outcome matches the price
 *   direction, $0 otherwise. Realized PnL is finalized at settlement.
 */
import type { MarketSymbol } from '../types/market'
import type { SimFill, SimOrder, SimPosition, PortfolioSnapshot, Outcome } from './types'

export interface SettlementOutcome {
  symbol:   MarketSymbol
  winner:   Outcome           // 'up' or 'down'
  closeTs:  number
}

function key(symbol: MarketSymbol, outcome: Outcome, windowTs: number): string {
  return `${symbol}:${outcome}:${windowTs}`
}

export class Portfolio {
  private cash:        number
  private readonly start: number
  private positions       = new Map<string, SimPosition>()
  private readonly fills: SimFill[] = []
  private peakEquity:  number

  private closedTrades  = 0
  private winners       = 0
  private losers        = 0
  private totalRealized = 0
  private totalFees     = 0
  private consecutiveLosses = 0
  private lastLossTs:   number | null = null

  constructor(startingCash: number) {
    this.cash       = startingCash
    this.start      = startingCash
    this.peakEquity = startingCash
  }

  // ── Read-only accessors ──────────────────────────────────────────────────

  getCash(): number { return this.cash }
  getStartCash(): number { return this.start }
  getOpenPositionCount(): number { return this.positions.size }
  getFills(): readonly SimFill[] { return this.fills }
  getPositions(): ReadonlyMap<string, Readonly<SimPosition>> { return this.positions }
  getConsecutiveLosses(): number { return this.consecutiveLosses }
  getLastLossTs(): number | null { return this.lastLossTs }

  getPosition(symbol: MarketSymbol, outcome: Outcome, windowTs: number): Readonly<SimPosition> | null {
    return this.positions.get(key(symbol, outcome, windowTs)) ?? null
  }

  // ── Apply a fill ──────────────────────────────────────────────────────────

  applyFill(order: SimOrder, fill: SimFill): void {
    this.fills.push(fill)
    this.totalFees += fill.fee

    const k        = key(order.symbol, order.outcome, order.windowTs)
    const existing = this.positions.get(k)

    if (fill.side === 'BUY') {
      this.cash -= (fill.size * fill.price + fill.fee)
      if (existing) {
        const newSize    = existing.size + fill.size
        const totalCost  = existing.avgEntryPrice * existing.size + fill.price * fill.size
        existing.size           = newSize
        existing.avgEntryPrice  = totalCost / newSize
        existing.totalFees     += fill.fee
        existing.lastMarkPrice  = fill.price
        existing.lastMarkMs     = fill.ts
      } else {
        this.positions.set(k, {
          symbol:        order.symbol,
          outcome:       order.outcome,
          windowTs:      order.windowTs,
          size:          fill.size,
          avgEntryPrice: fill.price,
          realizedPnl:   0,
          totalFees:     fill.fee,
          openTs:        fill.ts,
          lastMarkMs:    fill.ts,
          lastMarkPrice: fill.price,
        })
      }
    } else {
      // SELL — realize PnL on existing position
      if (!existing) return  // can't sell without a position; should be caught by risk manager
      this.cash += (fill.size * fill.price - fill.fee)

      const realized = fill.size * (fill.price - existing.avgEntryPrice) - fill.fee
      existing.realizedPnl += realized
      existing.size        -= fill.size
      existing.totalFees   += fill.fee
      existing.lastMarkPrice = fill.price
      existing.lastMarkMs    = fill.ts

      this.totalRealized += realized

      if (existing.size <= 1e-9) {
        this.closedTrades++
        if (existing.realizedPnl > 0) this.winners++
        else                          this.losers++
        if (existing.realizedPnl < 0) {
          this.consecutiveLosses++
          this.lastLossTs = fill.ts
        } else {
          this.consecutiveLosses = 0
        }
        this.positions.delete(k)
      }
    }

    this.updatePeakEquity(fill.ts)
  }

  // ── Settlement ────────────────────────────────────────────────────────────

  settleWindow(windowTs: number, outcomes: ReadonlyMap<MarketSymbol, Outcome>, ts: number): void {
    for (const [k, pos] of [...this.positions.entries()]) {
      if (pos.windowTs !== windowTs) continue
      const winner = outcomes.get(pos.symbol)
      if (!winner) continue

      const payout = pos.outcome === winner ? 1.0 : 0.0
      const proceeds = pos.size * payout
      this.cash += proceeds

      const settlementPnl = pos.size * (payout - pos.avgEntryPrice)
      pos.realizedPnl += settlementPnl
      this.totalRealized += settlementPnl

      this.closedTrades++
      if (pos.realizedPnl > 0) {
        this.winners++
        this.consecutiveLosses = 0
      } else {
        this.losers++
        this.consecutiveLosses++
        this.lastLossTs = ts
      }
      this.positions.delete(k)
    }
    this.updatePeakEquity(ts)
  }

  // Cancel open positions at last mark price (used at end of replay)
  forceCloseAllAtMark(ts: number): void {
    for (const [k, pos] of [...this.positions.entries()]) {
      const proceeds = pos.size * pos.lastMarkPrice
      this.cash += proceeds
      const realizedAtClose = pos.size * (pos.lastMarkPrice - pos.avgEntryPrice)
      pos.realizedPnl += realizedAtClose
      this.totalRealized += realizedAtClose
      this.closedTrades++
      if (pos.realizedPnl > 0) this.winners++
      else                      this.losers++
      this.positions.delete(k)
    }
    this.updatePeakEquity(ts)
  }

  // ── Mark-to-market ────────────────────────────────────────────────────────

  markPosition(symbol: MarketSymbol, outcome: Outcome, windowTs: number, mid: number, ts: number): void {
    const pos = this.positions.get(key(symbol, outcome, windowTs))
    if (!pos) return
    pos.lastMarkPrice = mid
    pos.lastMarkMs    = ts
    this.updatePeakEquity(ts)
  }

  // ── Snapshot for risk/observability ──────────────────────────────────────

  snapshot(killSwitchActive: boolean): PortfolioSnapshot {
    let positionsValue = 0
    let unrealized     = 0
    for (const pos of this.positions.values()) {
      positionsValue += pos.size * pos.lastMarkPrice
      unrealized     += pos.size * (pos.lastMarkPrice - pos.avgEntryPrice)
    }
    const equity   = this.cash + positionsValue
    const drawdown = this.peakEquity > 0 ? Math.max(0, (this.peakEquity - equity) / this.peakEquity) : 0

    const totalSlippage = this.fills.length > 0
      ? this.fills.reduce((s, f) => s + Math.abs(f.slippageBps), 0) / this.fills.length
      : 0

    return {
      cash:              this.cash,
      startCash:         this.start,
      positionsValue,
      totalEquity:       equity,
      realizedPnl:       this.totalRealized,
      unrealizedPnl:     unrealized,
      totalFees:         this.totalFees,
      totalSlippageBps:  totalSlippage,
      openPositions:     this.positions.size,
      closedTrades:      this.closedTrades,
      winners:           this.winners,
      losers:            this.losers,
      winRate:           this.closedTrades > 0 ? this.winners / this.closedTrades : 0,
      consecutiveLosses: this.consecutiveLosses,
      peakEquity:        this.peakEquity,
      drawdown,
      killSwitchActive,
    }
  }

  private updatePeakEquity(_ts: number): void {
    let positionsValue = 0
    for (const pos of this.positions.values()) positionsValue += pos.size * pos.lastMarkPrice
    const equity = this.cash + positionsValue
    if (equity > this.peakEquity) this.peakEquity = equity
  }
}
