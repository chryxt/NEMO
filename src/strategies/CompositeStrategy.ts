/**
 * Composite signal strategy — parameterized.
 *
 * Enters when:
 *   - composite.confidence > minConfidence
 *   - composite.agreement  > minAgreement
 *   - non-neutral direction
 *   - no existing position for (symbol, outcome, window)
 *   - >= minSecondsBeforeClose seconds remain in window
 *
 * All parameters default to config values for backward compatibility.
 * Validation framework instantiates with explicit params for sweeps.
 */
import { config } from '../config/index.js'
import type { Strategy } from './Strategy.js'
import type { SignalFrame } from '../signals/types.js'
import type { Portfolio } from '../sim/Portfolio.js'
import type { OrderRequest, Outcome } from '../sim/types.js'

export interface CompositeStrategyParams {
  minConfidence?:         number   // default: config.simMinConfidence
  minAgreement?:          number   // default: 0.6
  entrySize?:             number   // default: 100 shares
  priceSlackBps?:         number   // default: 50 (0.50% above ask)
  minSecondsBeforeClose?: number   // default: 15
}

export class CompositeStrategy implements Strategy {
  readonly name = 'composite'

  private readonly minConfidence:        number
  private readonly minAgreement:         number
  private readonly entrySize:            number
  private readonly priceSlackBps:        number
  private readonly minSecondsBeforeClose:number

  constructor(params: CompositeStrategyParams = {}) {
    this.minConfidence         = params.minConfidence         ?? config.simMinConfidence
    this.minAgreement          = params.minAgreement          ?? 0.6
    this.entrySize             = params.entrySize             ?? 100
    this.priceSlackBps         = params.priceSlackBps         ?? 50
    this.minSecondsBeforeClose = params.minSecondsBeforeClose ?? 15
  }

  onSignal(frame: SignalFrame, portfolio: Portfolio, _nowMs: number): OrderRequest | null {
    const { composite, features } = frame

    if (composite.confidence < this.minConfidence) return null
    if (composite.direction === 'neutral')          return null
    if (composite.agreement < this.minAgreement)    return null

    const outcome: Outcome = composite.direction === 'up' ? 'up' : 'down'

    if (portfolio.getPosition(frame.symbol, outcome, features.window.windowTs)) return null
    if (features.window.secondsToClose < this.minSecondsBeforeClose) return null

    const ask = features.quotes.ask
    if (ask == null) return null

    const limitPrice = Math.min(0.99, ask * (1 + this.priceSlackBps / 10_000))

    return {
      strategyId: this.name,
      symbol:     frame.symbol,
      outcome,
      side:       'BUY',
      type:       'IOC',
      size:       this.entrySize,
      limitPrice,
      reason:     `composite=${composite.value.toFixed(2)} conf=${composite.confidence.toFixed(2)} agree=${composite.agreement.toFixed(2)} regime=${frame.regime}`,
    }
  }
}
