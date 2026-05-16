/**
 * Whale-follow strategy — parameterized.
 *
 * Trigger: a whale.alert event for any symbol.
 * Action: enter same direction as the whale via IOC order.
 *
 * All parameters default to config values for backward compatibility.
 */
import { config } from '../config/index.js'
import type { Strategy } from './Strategy.js'
import type { SignalFrame } from '../signals/types.js'
import type { WhaleAlertEvent } from '../types/events.js'
import type { Portfolio } from '../sim/Portfolio.js'
import type { OrderRequest, Outcome } from '../sim/types.js'
import type { MarketSymbol } from '../types/market.js'

export interface WhaleFollowStrategyParams {
  entrySize?:          number   // default: 100
  priceSlackBps?:      number   // default: 50
  perSymbolCooldownMs?:number   // default: 60_000 (1 min)
  minWhaleSizeUsd?:    number   // default: config.simMinWhaleSizeUsd
}

export class WhaleFollowStrategy implements Strategy {
  readonly name = 'whale-follow'

  private readonly entrySize:          number
  private readonly priceSlackBps:      number
  private readonly perSymbolCooldownMs:number
  private readonly minWhaleSizeUsd:    number

  private lastEntryTs = new Map<MarketSymbol, number>()
  private features    = new Map<MarketSymbol, SignalFrame>()

  constructor(params: WhaleFollowStrategyParams = {}) {
    this.entrySize           = params.entrySize           ?? 100
    this.priceSlackBps       = params.priceSlackBps       ?? 50
    this.perSymbolCooldownMs = params.perSymbolCooldownMs ?? 60_000
    this.minWhaleSizeUsd     = params.minWhaleSizeUsd     ?? config.simMinWhaleSizeUsd
  }

  onSignal(frame: SignalFrame, _portfolio: Portfolio, _nowMs: number): OrderRequest | null {
    this.features.set(frame.symbol, frame)
    return null
  }

  onWhaleAlert(event: WhaleAlertEvent, portfolio: Portfolio, nowMs: number): OrderRequest | null {
    const { trade } = event
    const symbol = trade.symbol

    const lastEntry = this.lastEntryTs.get(symbol)
    if (lastEntry && nowMs - lastEntry < this.perSymbolCooldownMs) return null

    if (trade.sizeUsd < this.minWhaleSizeUsd) return null

    const frame = this.features.get(symbol)
    if (!frame) return null

    const outcomeStr = trade.outcome.toLowerCase()
    if (outcomeStr !== 'up' && outcomeStr !== 'down') return null
    const outcome: Outcome = outcomeStr

    if (portfolio.getPosition(symbol, outcome, frame.features.window.windowTs)) return null

    const ask = frame.features.quotes.ask
    if (ask == null) return null

    const limitPrice = Math.min(0.99, ask * (1 + this.priceSlackBps / 10_000))

    this.lastEntryTs.set(symbol, nowMs)

    return {
      strategyId: this.name,
      symbol,
      outcome,
      side:       'BUY',
      type:       'IOC',
      size:       this.entrySize,
      limitPrice,
      reason:     `whale ${trade.side} $${trade.sizeUsd.toFixed(0)} outcome=${trade.outcome}`,
    }
  }
}
