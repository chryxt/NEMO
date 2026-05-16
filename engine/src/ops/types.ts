/**
 * Phase 7 ops types — long-run operations, edge persistence, drift evolution,
 * reliability, dataset curation, operational safety.
 */
import type { PortfolioSnapshot } from '../sim/types'

// ── Edge persistence ─────────────────────────────────────────────────────────

export interface EdgeWindow {
  windowMin:        number      // rolling window size in minutes
  samples:          number      // number of return samples in window
  meanReturn:       number      // mean per-sample return (fraction)
  stdReturn:        number      // std-dev of returns
  rollingSharpe:    number      // annualized
  rollingHitRate:   number      // winners / closedTrades over window
  pnlStability:     number      // 1 - |skew| heuristic (higher = more stable)
  closedTrades:     number      // settled trades observed in this window
  netPnlUsd:        number      // change in totalEquity within window
}

export interface EdgePersistenceReport {
  generatedAtMs:    number
  startEquity:      number
  currentEquity:    number
  shortWindow:      EdgeWindow              // ~10 min
  mediumWindow:     EdgeWindow              // 1 h
  longWindow:       EdgeWindow              // 6 h
  confidenceDecayPerHour: number            // linear slope of avg-confidence vs hours
  edgeHalfLifeHours:      number | null     // null if insufficient data
  dailyHistory:     DailyEdgeBucket[]       // most recent N days
}

export interface DailyEdgeBucket {
  dateUtc:        string       // YYYY-MM-DD
  startEquity:    number
  endEquity:      number
  netPnlUsd:      number
  closedTrades:   number
  winners:        number
  hitRate:        number
  sharpe:         number
  signalCount:    number
  driftAlerts:    number
}

// ── Drift evolution ──────────────────────────────────────────────────────────

export interface DriftEvolutionPoint {
  ts:        number
  metric:    string
  drift:     number
  severity:  'info' | 'warning' | 'critical'
}

export interface StructuralBreakEvent {
  ts:        number
  metric:    string
  cusum:     number
  threshold: number
  reason:    string
}

export interface DriftEvolutionReport {
  generatedAtMs:        number
  recentDriftPoints:    DriftEvolutionPoint[]      // last N
  driftRatePerHour:     Record<string, number>     // alerts/hour per metric
  structuralBreaks:     StructuralBreakEvent[]
  regimeTransitions:    { ts: number; symbol: string; from: string; to: string }[]
}

// ── Reliability ──────────────────────────────────────────────────────────────

export interface ReliabilitySample {
  ts:         number
  heapMb:     number
  rssMb:      number
  eventLagMs: number   // oracle.price lag (Date.now() - event.ts)
}

export interface ReliabilityReport {
  generatedAtMs:      number
  uptimeSecs:         number
  rtdsReconnects:     number
  clobReconnects:     number
  rtdsUptimePct:      number     // 0..1 — fraction of session connected
  clobUptimePct:      number
  staleFeedIncidents: number     // count of system.warning since start
  degradedEpisodes:   number     // count of system.degraded since start
  avgEventLagMs:      number
  p99EventLagMs:      number
  avgHeapMb:          number
  peakHeapMb:         number
  memoryGrowthRatePerHr: number  // linear MB/h slope on heap samples
  diskFreeMb:         number | null
}

// ── Operational safety ───────────────────────────────────────────────────────

export interface OperationalSafetyStatus {
  strategyDegraded:        boolean
  strategyDegradedReason:  string | null
  reconnectStormActive:    boolean
  memoryPressureActive:    boolean
  feedEscalationActive:    boolean
  diskPressureActive:      boolean
}

// ── Dataset curation ─────────────────────────────────────────────────────────

export interface DatasetTags {
  regime:      string | null
  drift:       boolean                   // any active drift > warning
  killActive:  boolean
  degraded:    boolean                   // system.degraded currently
}

// ── Daily report ─────────────────────────────────────────────────────────────

export interface DailyReport {
  dateUtc:           string              // YYYY-MM-DD
  generatedAtMs:     number
  sessionStartMs:    number
  sessionEndMs:      number
  portfolio:         PortfolioSnapshot
  edge:              {
    netPnlUsd:        number
    closedTrades:     number
    winRate:          number
    sharpe:           number
    drawdown:         number
  }
  signals:           {
    count:           number
    avgConfidence:   number
    avgComputeUs:    number
    regimeMix:       Record<string, number>
  }
  drift:             {
    alertCount:      number
    criticalCount:   number
    structuralBreaks:number
  }
  reliability:       ReliabilityReport
  safety:            OperationalSafetyStatus
  whales:            { count: number; totalUsd: number }
}

// ── Combined ops snapshot ─────────────────────────────────────────────────────

export interface OpsSnapshot {
  enabled:        boolean
  startedAtMs:    number
  currentDateUtc: string
  edge:           EdgePersistenceReport
  drift:          DriftEvolutionReport
  reliability:    ReliabilityReport
  safety:         OperationalSafetyStatus
  reportsWritten: number
  datasetRecords: number
}
