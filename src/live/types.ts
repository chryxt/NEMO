/**
 * Phase 6 live-paper types — drift, health, observability, sessions.
 */
import type { PortfolioSnapshot, SimFill } from '../sim/types.js'
import type { MarketRegime } from '../signals/types.js'
import type { OpsSnapshot } from '../ops/types.js'
import type { ShadowSnapshot } from '../shadow/types.js'

// ── Baseline (loaded from a Phase 5 validation report) ───────────────────────

export interface LiveBaseline {
  source:      string             // path or description of source validation run
  generatedAt: number             // Unix ms
  metrics: {
    avgSignalsPerMin?:   number   // expected signal rate
    avgConfidence?:      number   // expected composite confidence
    avgSpread?:          number   // expected typical spread
    avgWhalesPerHour?:   number   // expected whale activity rate
    avgFillSlippageBps?: number   // expected per-fill slippage
    avgLatencyMs?:       number   // expected event→processing lag (wall clock - event ts)
  }
}

// ── Strategy health (rolling) ─────────────────────────────────────────────────

export interface StrategyHealthMetrics {
  signalCount:          number     // total observed since start
  signalsLast5Min:      number
  signalsPerMin:        number     // rolling 5-min rate
  avgConfidence:        number     // rolling avg over last N signals
  avgComputeLatencyUs:  number
  p99ComputeLatencyUs:  number
  directionFlipsLast5Min: number
  regimeTransitionsLast5Min: number
  currentRegime:        Partial<Record<MarketRegime, number>>  // count per regime in window
  recentFillCount:      number     // last 100 fills observed
  avgFillSlippageBps:   number
  lastSignalAgeMs:      number     // how long since last signal frame
}

// ── Drift detector output ─────────────────────────────────────────────────────

export interface DriftMetric {
  metric:    string
  baseline:  number
  current:   number
  drift:     number   // (current - baseline) / |baseline|
  severity:  'info' | 'warning' | 'critical'
}

export interface DriftReport {
  hasBaseline:    boolean
  baselineSource: string | null
  metrics:        DriftMetric[]
  criticalCount:  number
}

// ── Kill-switch ───────────────────────────────────────────────────────────────

export interface KillSwitchStatus {
  active:        boolean
  reason:        string | null
  triggeredBy:   string | null   // 'volatility' | 'latency' | 'stale-feed' | 'manual' | 'drift'
  triggeredAtMs: number | null
}

// ── Live paper snapshot (rendered by terminal) ────────────────────────────────

export interface LivePaperSnapshot {
  enabled:        boolean
  portfolio:      PortfolioSnapshot
  health:         StrategyHealthMetrics
  drift:          DriftReport
  killSwitch:     KillSwitchStatus
  recentFills:    SimFill[]   // last 5 for display
  ops?:           OpsSnapshot | null      // present when Phase 7 ops engine is enabled
  shadow?:        ShadowSnapshot | null   // present when Phase 8 shadow engine is enabled
}
