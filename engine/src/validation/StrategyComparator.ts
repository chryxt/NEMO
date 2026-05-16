/**
 * Strategy comparator — side-by-side benchmark across strategies × latency configs.
 *
 * Output is a flat matrix of cells (one per strategy × latency combination)
 * plus a ranked summary. Same input always yields the same ranking
 * (no tiebreaker randomness — order of insertion preserved on tie).
 */
import { log } from '../utils/logger'
import { runIsolatedSim } from './ReplayRunner'
import { LatencyModel } from '../sim/LatencyModel'
import type { Strategy } from '../strategies/Strategy'
import type {
  RecordedEvent, ComparatorCell, ComparisonResult,
} from './types'

export interface LatencyConfig {
  tag:        string
  decisionMs: number
  wsMs:       number
  execMs:     number
}

export interface StrategySpec {
  name:    string
  factory: () => Strategy[]
}

export interface ComparatorSpec {
  events:     RecordedEvent[]
  strategies: StrategySpec[]
  latencies:  LatencyConfig[]
}

export function runComparator(spec: ComparatorSpec): ComparisonResult {
  const cells: ComparatorCell[] = []

  for (const stratSpec of spec.strategies) {
    for (const latCfg of spec.latencies) {
      log.info(`[Comparator] running ${stratSpec.name} @ ${latCfg.tag}`)
      const latency = new LatencyModel(latCfg.decisionMs, latCfg.wsMs, latCfg.execMs)
      const result  = runIsolatedSim({
        events:     spec.events,
        strategies: stratSpec.factory(),
        latency,
        label:      `cmp-${stratSpec.name}-${latCfg.tag}`,
      })
      cells.push({
        strategyName: stratSpec.name,
        latencyTag:   latCfg.tag,
        report:       result.report,
        metrics:      result.metrics,
      })
      log.info(`[Comparator] ${stratSpec.name}@${latCfg.tag}: pnl=$${result.report.totalPnl.toFixed(2)} sharpe=${result.metrics.sharpe.toFixed(2)}`)
    }
  }

  // Rank by sharpe desc, fallback by pnl
  const ranking = [...cells].sort((a, b) => {
    const ds = b.metrics.sharpe - a.metrics.sharpe
    return ds !== 0 ? ds : (b.report.totalPnl - a.report.totalPnl)
  })

  return { cells, ranking }
}
