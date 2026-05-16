/**
 * Adversarial scenario testing.
 *
 * Each scenario is a deterministic event-stream transformer. We run the
 * baseline first, then each scenario, and report the PnL delta. A robust
 * strategy degrades gracefully across scenarios; an overfit strategy
 * collapses on specific stressors.
 *
 * All scenarios use closure state for stateful timing-based transforms.
 * No randomness — fully deterministic per scenario.
 */
import { log } from '../utils/logger'
import { runIsolatedSim } from './ReplayRunner'
import type { LatencyModel } from '../sim/LatencyModel'
import type { Strategy } from '../strategies/Strategy'
import type { RecordedEvent, ScenarioRun, ScenarioResult } from './types'
import type {
  ClobBestBidAskEvent, ClobPriceChangeEvent, ClobBookEvent,
  WhaleAlertEvent, MarketWindowOpenEvent,
} from '../types/events'

type Transformer = (event: RecordedEvent, idx: number) => RecordedEvent | RecordedEvent[] | null

export interface Scenario {
  name:        string
  description: string
  factory:     (events: RecordedEvent[]) => Transformer
}

// ── Built-in scenarios ────────────────────────────────────────────────────────

// Every 2 minutes, delay all events for 3 seconds (lag spike)
const lagSpikes: Scenario = {
  name:        'lag_spikes',
  description: 'WebSocket lag spike — 3s delay every 2 min',
  factory: (events) => {
    if (events.length === 0) return e => e
    const firstTs = events[0]!.ts
    return (event) => {
      const elapsed = event.ts - firstTs
      const cycle   = elapsed % (2 * 60_000)
      // 5-second lag window every 2 minutes
      const inSpike = cycle >= 0 && cycle < 5_000
      return inSpike ? { ...event, ts: event.ts + 3_000 } : event
    }
  },
}

// Drop oracle.price events for 60s every 5 min
const staleOracle: Scenario = {
  name:        'stale_oracle',
  description: 'Oracle feed gaps — drop oracle.price for 60s every 5 min',
  factory: (events) => {
    if (events.length === 0) return e => e
    const firstTs = events[0]!.ts
    return (event) => {
      if (event.event !== 'oracle.price') return event
      const elapsed = event.ts - firstTs
      const cycle   = elapsed % (5 * 60_000)
      const inGap   = cycle >= 60_000 && cycle < 120_000
      return inGap ? null : event
    }
  },
}

// Multiply spreads by 5x for 30s every 2 min
const spreadExplosion: Scenario = {
  name:        'spread_explosion',
  description: 'Spread explosion — spreads ×5 for 30s every 2 min',
  factory: (events) => {
    if (events.length === 0) return e => e
    const firstTs = events[0]!.ts
    const inExplosion = (ts: number): boolean => {
      const elapsed = ts - firstTs
      const cycle   = elapsed % (2 * 60_000)
      return cycle >= 0 && cycle < 30_000
    }
    return (event) => {
      if (!inExplosion(event.ts)) return event

      if (event.event === 'clob.bestBidAsk') {
        const bba = event.payload as ClobBestBidAskEvent
        const mid = (bba.bid + bba.ask) / 2
        const halfSpread = (bba.ask - bba.bid) / 2 * 5
        return {
          ...event,
          payload: {
            ...bba,
            bid: Math.max(0, mid - halfSpread),
            ask: Math.min(1, mid + halfSpread),
          },
        }
      }
      if (event.event === 'clob.priceChange') {
        const pc = event.payload as ClobPriceChangeEvent
        const mid = (pc.bestBid + pc.bestAsk) / 2
        const halfSpread = (pc.bestAsk - pc.bestBid) / 2 * 5
        return {
          ...event,
          payload: {
            ...pc,
            bestBid: Math.max(0, mid - halfSpread),
            bestAsk: Math.min(1, mid + halfSpread),
          },
        }
      }
      return event
    }
  },
}

// Reduce book depth by 80%
const lowLiquidity: Scenario = {
  name:        'low_liquidity',
  description: 'Low liquidity — orderbook depths reduced by 80%',
  factory: () => {
    return (event) => {
      if (event.event !== 'clob.book') return event
      const book = event.payload as ClobBookEvent
      return {
        ...event,
        payload: {
          ...book,
          bids: book.bids.map(b => ({ price: b.price, size: b.size * 0.2 })),
          asks: book.asks.map(a => ({ price: a.price, size: a.size * 0.2 })),
        },
      }
    }
  },
}

// Inject 3 fake whale alerts in the opposite direction at evenly spaced points
const whaleFakeouts: Scenario = {
  name:        'whale_fakeout',
  description: 'Inject 3 fake whale alerts with inverted direction',
  factory: (events) => {
    if (events.length < 100) return e => e
    // Find 3 real whale alerts to use as templates
    const realWhales = events.filter(e => e.event === 'whale.alert').slice(0, 3)
    if (realWhales.length === 0) return e => e

    const injectIdx = new Set<number>()
    const step = Math.floor(events.length / 4)
    for (let i = 1; i <= realWhales.length; i++) injectIdx.add(step * i)

    return (event, idx) => {
      if (!injectIdx.has(idx)) return event

      const template = realWhales[injectIdx.size - 1] ?? realWhales[0]!
      const trade = (template.payload as WhaleAlertEvent).trade
      // Invert side & outcome
      const flippedSide:    'BUY'  | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
      const flippedOutcome: string           = trade.outcome.toLowerCase() === 'up' ? 'Down' : 'Up'

      const fake: RecordedEvent = {
        ts:      event.ts + 1,   // slight offset so it slots after the trigger event
        event:   'whale.alert',
        payload: {
          trade: {
            ...trade,
            side:    flippedSide,
            outcome: flippedOutcome,
            ts:      Math.floor(event.ts / 1000),
            wallet:  '0xFAKE000000000000000000000000000000FAKE',
          },
        },
      }
      return [event, fake]
    }
  },
}

// Delay market.windowOpen by 5 seconds
const delayedRollover: Scenario = {
  name:        'delayed_rollover',
  description: 'Market window rollover delayed by 5 seconds',
  factory: () => {
    return (event) => {
      if (event.event !== 'market.windowOpen') return event
      const e = event.payload as MarketWindowOpenEvent
      return {
        ...event,
        ts: event.ts + 5_000,
        payload: { ...e, windowTs: e.windowTs + 5 },
      }
    }
  },
}

export const BUILTIN_SCENARIOS: Scenario[] = [
  lagSpikes,
  staleOracle,
  spreadExplosion,
  lowLiquidity,
  whaleFakeouts,
  delayedRollover,
]

export interface ScenarioSpec {
  events:     RecordedEvent[]
  strategies: Strategy[]
  latency:    LatencyModel
  scenarios?: Scenario[]     // defaults to all built-ins
}

export function runScenarios(spec: ScenarioSpec): ScenarioResult {
  const scenarios = spec.scenarios ?? BUILTIN_SCENARIOS

  // Baseline first
  log.info(`[Scenarios] running baseline (no perturbation)`)
  const baseline = runIsolatedSim({
    events:     spec.events,
    strategies: spec.strategies,
    latency:    spec.latency,
    label:      'baseline',
  })

  const runs: ScenarioRun[] = []
  let worstName  = ''
  let worstDelta = 0

  for (const scenario of scenarios) {
    log.info(`[Scenarios] running ${scenario.name} — ${scenario.description}`)
    const transformer = scenario.factory(spec.events)
    const r = runIsolatedSim({
      events:     spec.events,
      strategies: spec.strategies,
      latency:    spec.latency,
      transformer,
      label:      scenario.name,
    })

    const pnlDelta      = r.report.totalPnl - baseline.report.totalPnl
    const pnlDeltaPct   = Math.abs(baseline.report.totalPnl) > 0.01
      ? pnlDelta / Math.abs(baseline.report.totalPnl)
      : 0
    const drawdownDelta = r.report.maxDrawdown - baseline.report.maxDrawdown

    runs.push({
      scenario:       scenario.name,
      baselineReport: baseline.report,
      scenarioReport: r.report,
      pnlDelta,
      pnlDeltaPct,
      drawdownDelta,
    })

    if (pnlDelta < worstDelta) {
      worstDelta = pnlDelta
      worstName  = scenario.name
    }

    log.info(`[Scenarios] ${scenario.name}: pnlDelta=$${pnlDelta.toFixed(2)} (${(pnlDeltaPct * 100).toFixed(1)}%)  ddDelta=${(drawdownDelta * 100).toFixed(2)}%`)
  }

  return {
    baseline:      baseline.report,
    runs,
    worstScenario: worstName,
    worstDelta,
  }
}
