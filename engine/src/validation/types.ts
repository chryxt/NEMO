/**
 * Phase 5 validation types — research-grade robustness testing.
 */
import type { ExecutionReport } from '../sim/types.js'
import type { MarketRegime } from '../signals/types.js'
import type { MarketSymbol } from '../types/market.js'

// Format used by EventRecorder / EventReplayer (JSONL line)
export interface RecordedEvent {
  ts:      number   // wall-clock ms when recorded
  event:   string   // bus event name
  payload: unknown
}

// ── Risk analytics ────────────────────────────────────────────────────────────

export interface RiskMetrics {
  count:        number
  totalReturn:  number    // (endEquity - startCash) / startCash
  sharpe:       number    // annualized
  sortino:      number    // annualized, downside std
  maxDrawdown:  number    // fraction (0..1)
  ulcerIndex:  number
  calmar:       number    // annualizedReturn / maxDrawdown
  var5pct:      number    // 5th percentile of period returns
  consecutiveLossDistribution: Record<number, number>  // streak length → count
}

// ── Parameter sweep ───────────────────────────────────────────────────────────

export interface ParamPoint {
  params: Record<string, number | string | boolean>
  report: ExecutionReport
  metrics:RiskMetrics
}

export interface ParameterSweepResult {
  paramGrid: Record<string, Array<number | string | boolean>>
  totalCombinations: number
  points:    ParamPoint[]
  best:      ParamPoint | null
  worst:     ParamPoint | null
  stability: number   // std-dev of PnL across all points / mean(|PnL|)
}

// ── Walk-forward ──────────────────────────────────────────────────────────────

export interface WalkForwardWindow {
  index:      number
  trainFromTs:number
  trainToTs:  number
  testFromTs: number
  testToTs:   number
  bestParams: Record<string, number | string | boolean>
  trainReport: ExecutionReport
  testReport:  ExecutionReport
  trainMetrics:RiskMetrics
  testMetrics: RiskMetrics
}

export interface WalkForwardResult {
  windows:                WalkForwardWindow[]
  avgTestSharpe:          number
  stdTestSharpe:          number   // lower = more consistent
  avgTrainPnl:            number
  avgTestPnl:             number
  trainToTestPnlRatio:    number   // > 1.5 = overfitting risk
  consistencyScore:       number   // 1 - (stdTestSharpe / |avgTestSharpe|)
}

// ── Monte Carlo ───────────────────────────────────────────────────────────────

export interface MonteCarloPerturbation {
  latencyJitterMs?:     number    // std dev of gaussian noise on latency
  whaleShiftMs?:        number    // max ± uniform shift for whale alerts
  spreadMultiplierStd?: number    // std dev for N(1, σ²) spread multiplier
  slippageBpsExtra?:    number    // fixed extra bps on every fill (cost only)
}

export interface MonteCarloRun {
  seed:    number
  report:  ExecutionReport
  metrics: RiskMetrics
}

export interface MonteCarloResult {
  numRuns:        number
  perturbation:   MonteCarloPerturbation
  runs:           MonteCarloRun[]
  pnlMean:        number
  pnlStd:         number
  pnlP5:          number
  pnlP95:         number
  pnlMedian:      number
  probabilityOfLoss: number
  sharpeMean:     number
  sharpeStd:      number
  worstDrawdown:  number
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

export interface ScenarioRun {
  scenario:      string
  baselineReport:ExecutionReport
  scenarioReport:ExecutionReport
  pnlDelta:      number    // scenario - baseline
  pnlDeltaPct:   number    // pnlDelta / |baseline.totalPnl|
  drawdownDelta: number
}

export interface ScenarioResult {
  baseline:      ExecutionReport
  runs:          ScenarioRun[]
  worstScenario: string
  worstDelta:    number
}

// ── Strategy comparison ──────────────────────────────────────────────────────

export interface ComparatorCell {
  strategyName: string
  latencyTag:   string
  report:       ExecutionReport
  metrics:      RiskMetrics
}

export interface ComparisonResult {
  cells:    ComparatorCell[]
  ranking:  ComparatorCell[]  // sorted by sharpe descending
}

// ── Overfitting detection ────────────────────────────────────────────────────

export interface OverfittingFinding {
  check:     string
  passed:    boolean
  score:     number          // domain-specific (0..1, 1 = best)
  detail:    string
}

export interface OverfittingReport {
  findings: OverfittingFinding[]
  overallScore: number       // mean of pass-weighted scores (0..1)
}

// ── Aggregate validation report ──────────────────────────────────────────────

export interface ValidationReport {
  sessionId:       string
  replaySource:    string
  generatedAt:     number    // Unix ms when produced
  outputDir:       string

  sweep?:        ParameterSweepResult
  walkForward?:  WalkForwardResult
  monteCarlo?:   MonteCarloResult
  scenarios?:    ScenarioResult
  comparison?:   ComparisonResult
  overfitting?:  OverfittingReport
}

// ── Per-symbol regime distribution (used by validation reports) ──────────────
export type RegimeDistribution = Partial<Record<MarketRegime, number>>
export type PerSymbolMap<T>    = Partial<Record<MarketSymbol, T>>
