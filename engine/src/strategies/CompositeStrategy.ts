/**
 * Composite signal strategy.
 *
 * Enters when:
 *   - composite confidence > minConfidence
 *   - composite agreement   > minAgreement
 *   - non-neutral direction
 *   - no existing position for (symbol, outcome, window)
 *
 * Exits on window settlement (handled by Portfolio.settleWindow).
 * Uses IOC orders to avoid stale resting orders.
 */
import { config } from '../config/index.js'
import type { Strategy } from './Strategy.js'
import type { SignalFrame } from '../signals/types.js'
import type { Portfolio } from '../sim/Portfolio.js'
import type { OrderRequest, Outcome } from '../sim/types.js'

const ENTRY_SIZE       = 100   // shares per entry — $50–$70 depending on price
const PRICE_SLACK_BPS  = 50    // 0.50% above ask we're willing to pay

export class CompositeStrategy implements Strategy {
  readonly name = 'composite'

  onSignal(frame: SignalFrame, portfolio: Portfolio, _nowMs: number): OrderRequest | null {
    const { composite, features } = frame

    if (composite.confidence < config.simMinConfidence) return null
    if (composite.direction === 'neutral')              return null
    if (composite.agreement < 0.6)                       return null

    const outcome: Outcome = composite.direction === 'up' ? 'up' : 'down'

    // Already in position for this symbol+outcome+window
    const windowTs = features.window.windowTs
    if (portfolio.getPosition(frame.symbol, outcome, windowTs)) return null

    // Don't enter in the last 15 seconds — not enough time to capture move
    if (features.window.secondsToClose < 15) return null

    // Need a quote to set a sane limit price
    const ask = features.quotes.ask
    if (ask == null) return null

    const limitPrice = Math.min(0.99, ask * (1 + PRICE_SLACK_BPS / 10_000))

    return {
      strategyId: this.name,
      symbol:     frame.symbol,
      outcome,
      side:       'BUY',
      type:       'IOC',
      size:       ENTRY_SIZE,
      limitPrice,
      reason:     `composite=${composite.value.toFixed(2)} conf=${composite.confidence.toFixed(2)} agree=${composite.agreement.toFixed(2)} regime=${frame.regime}`,
    }
  }
}
