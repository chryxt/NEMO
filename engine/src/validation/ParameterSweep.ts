/**
 * Parameter grid sweep — exhaustive search across a parameter cube.
 *
 * For each combination, runs an isolated simulation and records PnL +
 * full ExecutionReport + RiskMetrics. Returns ranked points and a
 * stability score (std / mean) that flags parameter overfit risk.
 */
import { log } from '../utils/logger'
import { runIsolatedSim } from './ReplayRunner'
import type { RunSpec } from './ReplayRunner'
import type { LatencyModel } from '../sim/LatencyModel'
import type { Strategy } from '../strategies/Strategy'
import type { RecordedEvent, ParameterSweepResult, ParamPoint } from './types'

export type ParamGrid = Record<string, Array<number | string | boolean>>
export type StrategyFactory = (params: Record<string, number | string | boolean>) => Strategy[]

export interface SweepSpec {
  events:           RecordedEvent[]
  paramGrid:        ParamGrid
  strategyFactory:  StrategyFactory
  latency:          LatencyModel
  fromTs?:          number
  toTs?:            number
}

/** Cartesian product of grid values → flat list of param dicts. */
function cartesian(grid: ParamGrid): Array<Record<string, number | string | boolean>> {
  const keys = Object.keys(grid)
  if (keys.length === 0) return [{}]
  const combos: Array<Record<string, number | string | boolean>> = [{}]
  for (const k of keys) {
    const next: Array<Record<string, number | string | boolean>> = []
    for (const combo of combos) {
      for (const v of grid[k]!) next.push({ ...combo, [k]: v })
    }
    combos.length = 0
    combos.push(...next)
  }
  return combos
}

export function runParameterSweep(spec: SweepSpec): ParameterSweepResult {
  const combos = cartesian(spec.paramGrid)
  log.info(`[Sweep] ${combos.length} param combinations × ${spec.events.length} events`)

  const points: ParamPoint[] = []
  for (let i = 0; i < combos.length; i++) {
    const params = combos[i]!
    const runSpec: RunSpec = {
      events:     spec.events,
      strategies: spec.strategyFactory(params),
      latency:    spec.latency,
      fromTs:     spec.fromTs,
      toTs:       spec.toTs,
      label:      `sweep-${i + 1}-${combos.length}`,
    }
    const result = runIsolatedSim(runSpec)
    points.push({ params, report: result.report, metrics: result.metrics })

    if ((i + 1) % 10 === 0 || i === combos.length - 1) {
      log.info(`[Sweep] ${i + 1}/${combos.length}  pnl=$${result.report.totalPnl.toFixed(2)}  sharpe=${result.metrics.sharpe.toFixed(2)}`)
    }
  }

  // Rank + stability
  const ranked = [...points].sort((a, b) => b.report.totalPnl - a.report.totalPnl)
  const pnls   = points.map(p => p.report.totalPnl)
  const mean   = pnls.reduce((s, x) => s + x, 0) / Math.max(pnls.length, 1)
  const variance = pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(pnls.length, 1)
  const std    = Math.sqrt(variance)
  const stability = Math.abs(mean) > 1 ? std / Math.abs(mean) : std

  return {
    paramGrid: spec.paramGrid,
    totalCombinations: combos.length,
    points,
    best:  ranked[0] ?? null,
    worst: ranked[ranked.length - 1] ?? null,
    stability,
  }
}
