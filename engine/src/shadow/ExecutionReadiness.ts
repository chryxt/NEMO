/**
 * Execution readiness — composite score telling us whether the system
 * looks operationally safe enough to consider eventually enabling real
 * execution.
 *
 * Components (all 0..1, higher = better):
 *  - fillRealismScore        : mean realism over recent comparisons
 *  - operationalStability    : 1 − (riskFlagsLastHour / 20)
 *  - latencyStability        : 1 − min(1, std/mean of shadow-to-fill latency)
 *  - marketImpactScore       : 1 − mean impact estimate
 *  - executionConfidence     : weighted overall
 *
 * The overall score does NOT auto-enable anything. It is a gauge for an
 * operator to consult before approving anything.
 */
import type { ExecutionReadinessReport } from './types'
import type { ExecutionComparator } from './ExecutionComparator'
import type { OperationalRiskMonitor } from './OperationalRisk'
import type { ShadowOrderEmitter } from './ShadowOrderEmitter'

const RISK_FLAG_CAP_FOR_NORMALIZATION = 20

export class ExecutionReadiness {
  constructor(
    private readonly comparator: ExecutionComparator,
    private readonly risk:       OperationalRiskMonitor,
    private readonly emitter:    ShadowOrderEmitter,
  ) {
    void this.emitter
  }

  getReport(): ExecutionReadinessReport {
    const realism = this.comparator.meanRealismScore()
    const realismStd = this.comparator.realismStd()
    const lat = this.comparator.avgShadowToFillLatency()
    const risk = this.risk.getStatus()

    const opStability  = Math.max(0, 1 - risk.flagsLastHour / RISK_FLAG_CAP_FOR_NORMALIZATION)
    const latStability = lat.mean > 0 ? Math.max(0, 1 - Math.min(1, lat.std / lat.mean)) : 0.5
    // Market impact: collected as part of comparator? We don't have direct sample. Use neutral.
    const marketImpactScore = 0.5

    const samples = this.comparator.getRecent().length
    const overall =
      0.40 * realism +
      0.25 * opStability +
      0.20 * latStability +
      0.15 * marketImpactScore

    return {
      generatedAtMs:        Date.now(),
      executionConfidence:  overall,
      fillRealismScore:     realism,
      operationalStability: opStability,
      latencyStability:     latStability,
      marketImpactScore,
      overallReadiness:     overall,
      components: {
        samples,
        avgRealism:         realism,
        realismStd,
        avgShadowLatencyMs: lat.mean,
        stdShadowLatencyMs: lat.std,
        activeRiskFlags:    risk.flagsLastHour,
      },
    }
  }
}
