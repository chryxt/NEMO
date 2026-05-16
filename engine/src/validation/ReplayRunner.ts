/**
 * Isolated simulation runner — the workhorse of all Phase 5 tools.
 *
 * Runs one complete simulation against a pre-loaded event stream with an
 * optional event transformer (for Monte Carlo perturbations / scenarios).
 * Between runs, the global event bus is reset so prior listeners cannot
 * affect subsequent runs.
 *
 * Determinism guarantee: same events + same strategies + same latency +
 * same transformer = identical ExecutionReport (modulo the sessionId label).
 */
import { readFileSync } from 'fs'
import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { SignalEngine } from '../signals/SignalEngine'
import { SimulationEngine } from '../sim/SimulationEngine'
import { LatencyModel } from '../sim/LatencyModel'
import { ExecutionAnalytics } from '../research/ExecutionAnalytics'
import type { Strategy } from '../strategies/Strategy'
import type { SignalFrame, MarketRegime } from '../signals/types'
import type { ExecutionReport, SimFill } from '../sim/types'
import type { MarketSymbol } from '../types/market'
import type { BusEvents } from '../types/events'
import type { RecordedEvent } from './types'
import { computeRiskMetrics } from './RiskMetrics'
import type { RiskMetrics } from './types'

let runCounter = 0

export interface RunSpec {
  events:      RecordedEvent[]
  strategies:  Strategy[]
  latency:     LatencyModel
  fromTs?:     number
  toTs?:       number
  // Optional transformer applied to each event before bus.emit().
  // Return null to drop the event. Return an array to inject extra events
  // in place of the original. Pure (deterministic given a seeded random).
  transformer?: (event: RecordedEvent, idx: number) => RecordedEvent | RecordedEvent[] | null
  label?:      string
}

export interface RunResult {
  sessionId: string
  report:    ExecutionReport
  metrics:   RiskMetrics
  fills:     readonly SimFill[]
  equity:    number[]
}

export function loadReplayFile(path: string): RecordedEvent[] {
  const raw = readFileSync(path, 'utf8')
  const out: RecordedEvent[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as RecordedEvent)
    } catch {
      // Skip malformed lines silently — same behavior as EventReplayer
    }
  }
  return out
}

export function runIsolatedSim(spec: RunSpec): RunResult {
  bus.reset()

  const sessionId = `iso-${++runCounter}-${spec.label ?? 'run'}`

  const signalEngine = new SignalEngine()
  signalEngine.start()

  const sim = new SimulationEngine(spec.latency, spec.strategies)
  sim.start()

  // Track regime history per symbol for execution attribution
  const regimeHist = new Map<MarketSymbol, Array<{ ts: number; regime: MarketRegime }>>()
  bus.on('signal.frame', ({ frame }) => {
    const arr = regimeHist.get(frame.symbol) ?? []
    arr.push({ ts: frame.ts, regime: frame.regime })
    regimeHist.set(frame.symbol, arr)
  })

  // Track equity curve from portfolio snapshots over time (sampled at each oracle.price)
  const equity: number[] = []
  bus.on('oracle.price', () => {
    const snap = sim.getPortfolio().snapshot(false)
    equity.push(snap.totalEquity)
  })

  // Replay events (with optional transform)
  let firstTs = 0
  let lastTs  = 0

  const emitOne = (e: RecordedEvent): void => {
    try {
      bus.emit(e.event as keyof BusEvents, e.payload as never)
    } catch {
      // Skip unrecognized event types — same fault tolerance as EventReplayer
    }
  }

  for (let i = 0; i < spec.events.length; i++) {
    const evt = spec.events[i]!
    if (spec.fromTs != null && evt.ts < spec.fromTs) continue
    if (spec.toTs   != null && evt.ts > spec.toTs)   break

    const out = spec.transformer ? spec.transformer(evt, i) : evt
    if (out == null) continue

    if (Array.isArray(out)) {
      for (const sub of out) {
        if (firstTs === 0) firstTs = sub.ts
        lastTs = sub.ts
        emitOne(sub)
      }
    } else {
      if (firstTs === 0) firstTs = out.ts
      lastTs = out.ts
      emitOne(out)
    }
  }

  sim.stop()
  signalEngine.stop()

  // Final equity sample
  equity.push(sim.getPortfolio().snapshot(false).totalEquity)

  // Build regime lookup
  const regimeByTs = (sym: MarketSymbol, ts: number): MarketRegime | undefined => {
    const arr = regimeHist.get(sym)
    if (!arr || arr.length === 0) return undefined
    let lo = 0, hi = arr.length - 1, idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid]!.ts <= ts) { idx = mid; lo = mid + 1 }
      else                       hi = mid - 1
    }
    return idx >= 0 ? arr[idx]!.regime : undefined
  }

  const analytics  = new ExecutionAnalytics('/tmp/_validation_unused', sessionId)
  const strategyTag = spec.strategies.map(s => s.name).join('+')
  const report = analytics.produce(sim, strategyTag, firstTs, lastTs, regimeByTs)
  const metrics = computeRiskMetrics(equity)

  log.debug(`[ReplayRunner] ${sessionId} done — pnl=$${report.totalPnl.toFixed(2)} sharpe=${metrics.sharpe.toFixed(2)}`)

  return {
    sessionId,
    report,
    metrics,
    fills: [...sim.getPortfolio().getFills()],
    equity,
  }
}
