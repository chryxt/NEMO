/**
 * Anti-overfitting framework.
 *
 * Four orthogonal checks:
 *   1. Parameter stability:    PnL variance across nearby parameter combos
 *   2. Period consistency:     stability of test-window Sharpe across walk-forward
 *   3. Train→test PnL ratio:   ratio of avg train PnL to avg test PnL
 *   4. Truncation invariance:  signals on [0, T] should be identical regardless of
 *                              whether replay extends to T or 2T (catches lookahead)
 *
 * Each check produces a score 0..1 (1 = best). The overall report aggregates.
 */
import { log } from '../utils/logger'
import { runIsolatedSim } from './ReplayRunner'
import { SignalEngine } from '../signals/SignalEngine'
import { bus } from '../bus/EventBus'
import type { Strategy } from '../strategies/Strategy'
import type { LatencyModel } from '../sim/LatencyModel'
import type {
  RecordedEvent, OverfittingFinding, OverfittingReport,
  ParameterSweepResult, WalkForwardResult,
} from './types'
import type { BusEvents } from '../types/events'

const PASS_THRESHOLD = {
  paramStability:      0.5,    // stability < 0.5 = pass (lower is more stable)
  consistency:         0.5,    // consistencyScore > 0.5 = pass
  trainToTestRatio:    2.0,    // < 2.0 = pass (train PnL not >2× test)
  truncationDriftMax:  0.001,  // max relative diff in features at shared timestamps
}

// 1. Parameter stability — derived from a completed ParameterSweepResult
export function checkParameterStability(sweep: ParameterSweepResult): OverfittingFinding {
  const passed = sweep.stability < PASS_THRESHOLD.paramStability
  const score  = Math.max(0, 1 - sweep.stability)
  return {
    check:  'parameter_stability',
    passed,
    score,
    detail: `pnl std/mean = ${sweep.stability.toFixed(3)} across ${sweep.totalCombinations} param combos (lower is more robust; pass < ${PASS_THRESHOLD.paramStability})`,
  }
}

// 2. Period consistency — derived from WalkForwardResult
export function checkPeriodConsistency(wf: WalkForwardResult): OverfittingFinding {
  const passed = wf.consistencyScore >= PASS_THRESHOLD.consistency
  return {
    check:  'period_consistency',
    passed,
    score:  wf.consistencyScore,
    detail: `consistencyScore=${wf.consistencyScore.toFixed(3)} (avg test Sharpe=${wf.avgTestSharpe.toFixed(2)} ± ${wf.stdTestSharpe.toFixed(2)} across ${wf.windows.length} windows)`,
  }
}

// 3. Train→test PnL ratio
export function checkTrainTestRatio(wf: WalkForwardResult): OverfittingFinding {
  const ratio = wf.trainToTestPnlRatio
  const passed = isFinite(ratio) && Math.abs(ratio) < PASS_THRESHOLD.trainToTestRatio
  const score  = passed
    ? Math.max(0, 1 - Math.abs(ratio - 1) / PASS_THRESHOLD.trainToTestRatio)
    : 0
  return {
    check:  'train_test_pnl_ratio',
    passed,
    score,
    detail: `train→test PnL ratio = ${isFinite(ratio) ? ratio.toFixed(2) : '∞'} (pass < ${PASS_THRESHOLD.trainToTestRatio})`,
  }
}

// 4. Truncation invariance — run signal engine on full vs truncated replay
//    and compare signal frames at shared timestamps.
export interface TruncationCheckSpec {
  events:     RecordedEvent[]
  strategies: Strategy[]   // unused for signal-frame comparison; kept for symmetry
  latency:    LatencyModel
  truncFraction: number    // e.g., 0.6 = compare first 60% of replay against full
}

export function checkTruncationInvariance(spec: TruncationCheckSpec): OverfittingFinding {
  const fullEvents = spec.events
  if (fullEvents.length < 100) {
    return {
      check: 'truncation_invariance', passed: true, score: 1,
      detail: 'skipped — replay too short for meaningful check',
    }
  }

  const truncCutoff = fullEvents[Math.floor(fullEvents.length * spec.truncFraction)]!.ts

  // Helper: run signal engine over events, collect signal frames keyed by (symbol, ts)
  const collectFrames = (events: RecordedEvent[]): Map<string, number> => {
    bus.reset()
    const signalEngine = new SignalEngine()
    signalEngine.start()
    const frames = new Map<string, number>()

    bus.on('signal.frame', ({ frame }) => {
      // Only compare on the shared range
      if (frame.ts > truncCutoff) return
      // Key: symbol + ts + composite.value to detect divergence
      frames.set(`${frame.symbol}:${frame.ts}`, frame.composite.value)
    })

    for (const e of events) {
      try { bus.emit(e.event as keyof BusEvents, e.payload as never) } catch { /* skip */ }
    }
    signalEngine.stop()
    return frames
  }

  // Run on full and truncated event streams
  const truncEvents = fullEvents.filter(e => e.ts <= truncCutoff)
  log.info(`[Overfit] truncation check: full=${fullEvents.length} truncated=${truncEvents.length} cutoff=${truncCutoff}`)

  const framesFull  = collectFrames(fullEvents)
  const framesTrunc = collectFrames(truncEvents)

  // Compare frames at shared keys
  let maxDrift  = 0
  let compared  = 0
  for (const [k, vFull] of framesFull) {
    const vTrunc = framesTrunc.get(k)
    if (vTrunc == null) continue
    const drift = Math.abs(vFull - vTrunc)
    if (drift > maxDrift) maxDrift = drift
    compared++
  }

  const passed = maxDrift <= PASS_THRESHOLD.truncationDriftMax
  const score  = passed ? 1.0 : Math.max(0, 1 - maxDrift / 0.1)

  return {
    check:  'truncation_invariance',
    passed,
    score,
    detail: `${compared} shared frames, max composite-value drift=${maxDrift.toExponential(2)} (pass <= ${PASS_THRESHOLD.truncationDriftMax})`,
  }
}

export interface DetectorSpec {
  sweep?:       ParameterSweepResult
  walkForward?: WalkForwardResult
  truncCheck?:  TruncationCheckSpec
}

export function runOverfittingDetector(spec: DetectorSpec): OverfittingReport {
  const findings: OverfittingFinding[] = []
  if (spec.sweep)       findings.push(checkParameterStability(spec.sweep))
  if (spec.walkForward) {
    findings.push(checkPeriodConsistency(spec.walkForward))
    findings.push(checkTrainTestRatio(spec.walkForward))
  }
  if (spec.truncCheck)  findings.push(checkTruncationInvariance(spec.truncCheck))

  const overallScore = findings.length > 0
    ? findings.reduce((s, f) => s + f.score, 0) / findings.length
    : 0

  return { findings, overallScore }
}

// Use 'BusEvents' type elsewhere — explicit re-export to keep types isolated
export type { BusEvents }
