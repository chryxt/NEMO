/**
 * Whale-follow strategy.
 *
 * Trigger: a whale.alert event for any symbol.
 * Action: enter same direction as the whale via IOC order.
 *
 * Premise: large traders are often better informed about near-term direction.
 * Cooldown is enforced by RiskManager (post-loss), but we also throttle
 * per-symbol to avoid stacking on rapid-fire whale clusters.
 */
import { config } from '../config/index.js'
import type { Strategy } from './Strategy.js'
import type { SignalFrame } from '../signals/types.js'
import type { WhaleAlertEvent } from '../types/events.js'
import type { Portfolio } from '../sim/Portfolio.js'
import type { OrderRequest, Outcome } from '../sim/types.js'
import type { MarketSymbol } from '../types/market.js'

const ENTRY_SIZE      = 100
const PRICE_SLACK_BPS = 50
const PER_SYMBOL_COOLDOWN_MS = 60_000  // 1 min per symbol

export class WhaleFollowStrategy implements Strategy {
  readonly name = 'whale-follow'

  // Track last entry time per symbol for cooldown
  private lastEntryTs = new Map<MarketSymbol, number>()
  // Cache latest features per symbol to know window/quotes
  private features:    Map<MarketSymbol, SignalFrame> = new Map()

  onSignal(frame: SignalFrame, _portfolio: Portfolio, _nowMs: number): OrderRequest | null {
    this.features.set(frame.symbol, frame)
    return null  // entries are driven by whale alerts, not signals
  }

  onWhaleAlert(event: WhaleAlertEvent, portfolio: Portfolio, nowMs: number): OrderRequest | null {
    const { trade } = event
    const symbol = trade.symbol

    // Cooldown per symbol
    const lastEntry = this.lastEntryTs.get(symbol)
    if (lastEntry && nowMs - lastEntry < PER_SYMBOL_COOLDOWN_MS) return null

    // Whale-volume threshold (additional filter beyond bus emission)
    if (trade.sizeUsd < config.simMinWhaleSizeUsd) return null

    // Need recent features for window/quote info
    const frame = this.features.get(symbol)
    if (!frame) return null

    // Map whale's outcome to our Outcome type
    const outcomeStr = trade.outcome.toLowerCase()
    if (outcomeStr !== 'up' && outcomeStr !== 'down') return null
    const outcome: Outcome = outcomeStr

    // Position dedup
    if (portfolio.getPosition(symbol, outcome, frame.features.window.windowTs)) return null

    // Need a quote
    const ask = frame.features.quotes.ask
    if (ask == null) return null

    const limitPrice = Math.min(0.99, ask * (1 + PRICE_SLACK_BPS / 10_000))

    this.lastEntryTs.set(symbol, nowMs)

    return {
      strategyId: this.name,
      symbol,
      outcome,
      side:       'BUY',
      type:       'IOC',
      size:       ENTRY_SIZE,
      limitPrice,
      reason:     `whale ${trade.side} $${trade.sizeUsd.toFixed(0)} outcome=${trade.outcome}`,
    }
  }
}
