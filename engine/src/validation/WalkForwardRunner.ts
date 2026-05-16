/**
 * Walk-forward analysis.
 *
 * For each rolling window:
 *   1. Run parameter sweep on the train portion
 *   2. Pick best parameters by train PnL
 *   3. Apply those parameters to the test portion (out-of-sample)
 *   4. Record both train and test reports
 *
 * Aggregated metrics expose overfit risk:
 *   - train→test PnL ratio >> 1 = train-period overfitting
 *   - std-dev of test Sharpe across windows = inconsistency
 */
import { log } from '../utils/logger'
import { runIsolatedSim } from './ReplayRunner'
import { runParameterSweep } from './ParameterSweep'
import type { ParamGrid, StrategyFactory } from './ParameterSweep'
import type { LatencyModel } from '../sim/LatencyModel'
import type { RecordedEvent, WalkForwardResult, WalkForwardWindow } from './types'

export interface WalkForwardSpec {
  events:           RecordedEvent[]
  paramGrid:        ParamGrid
  strategyFactory:  StrategyFactory
  latency:          LatencyModel
  windowMs:         number    // total window size (train + test)
  trainFraction:    number    // 0..1
  stepMs:           number    // advance per iteration
  minEventsPerWin:  number    // skip windows with fewer events than this
}

export function runWalkForward(spec: WalkForwardSpec): WalkForwardResult {
  if (spec.events.length === 0) {
    return {
      windows: [], avgTestSharpe: 0, stdTestSharpe: 0,
      avgTrainPnl: 0, avgTestPnl: 0, trainToTestPnlRatio: 0, consistencyScore: 0,
    }
  }

  const firstTs = spec.events[0]!.ts
  const lastTs  = spec.events[spec.events.length - 1]!.ts
  const total   = lastTs - firstTs

  if (total < spec.windowMs) {
    log.warn(`[WalkForward] replay too short (${(total / 60_000).toFixed(1)}min) for window (${(spec.windowMs / 60_000).toFixed(1)}min)`)
    return {
      windows: [], avgTestSharpe: 0, stdTestSharpe: 0,
      avgTrainPnl: 0, avgTestPnl: 0, trainToTestPnlRatio: 0, consistencyScore: 0,
    }
  }

  const windows: WalkForwardWindow[] = []
  let windowIdx = 0
  for (let start = firstTs; start + spec.windowMs <= lastTs; start += spec.stepMs) {
    const winEnd     = start + spec.windowMs
    const trainEnd   = start + Math.floor(spec.windowMs * spec.trainFraction)

    const trainEvents = spec.events.filter(e => e.ts >= start && e.ts < trainEnd).length
    const testEvents  = spec.events.filter(e => e.ts >= trainEnd && e.ts < winEnd).length
    if (trainEvents < spec.minEventsPerWin || testEvents < spec.minEventsPerWin) {
      log.debug(`[WalkForward] skip window ${windowIdx} — train=${trainEvents} test=${testEvents}`)
      windowIdx++
      continue
    }

    log.info(`[WalkForward] window ${windowIdx}: train=[${start}-${trainEnd}] test=[${trainEnd}-${winEnd}]  events: train=${trainEvents} test=${testEvents}`)

    // 1. Train sweep
    const sweep = runParameterSweep({
      events:    spec.events,
      paramGrid: spec.paramGrid,
      strategyFactory: spec.strategyFactory,
      latency:   spec.latency,
      fromTs:    start,
      toTs:      trainEnd,
    })

    if (!sweep.best) {
      log.warn(`[WalkForward] window ${windowIdx} train sweep produced no best params`)
      windowIdx++
      continue
    }

    // 2. Apply best params to test range
    const testResult = runIsolatedSim({
      events:     spec.events,
      strategies: spec.strategyFactory(sweep.best.params),
      latency:    spec.latency,
      fromTs:     trainEnd,
      toTs:       winEnd,
      label:      `wf-${windowIdx}-test`,
    })

    windows.push({
      index:        windowIdx,
      trainFromTs:  start,
      trainToTs:    trainEnd,
      testFromTs:   trainEnd,
      testToTs:     winEnd,
      bestParams:   sweep.best.params,
      trainReport:  sweep.best.report,
      testReport:   testResult.report,
      trainMetrics: sweep.best.metrics,
      testMetrics:  testResult.metrics,
    })

    log.info(`[WalkForward] window ${windowIdx}: trainPnL=$${sweep.best.report.totalPnl.toFixed(2)} testPnL=$${testResult.report.totalPnl.toFixed(2)} testSharpe=${testResult.metrics.sharpe.toFixed(2)}`)
    windowIdx++
  }

  // Aggregate
  if (windows.length === 0) {
    return {
      windows: [], avgTestSharpe: 0, stdTestSharpe: 0,
      avgTrainPnl: 0, avgTestPnl: 0, trainToTestPnlRatio: 0, consistencyScore: 0,
    }
  }

  const testSharpes = windows.map(w => w.testMetrics.sharpe)
  const avgTestSharpe = testSharpes.reduce((a, b) => a + b, 0) / testSharpes.length
  const stdTestSharpe = Math.sqrt(
    testSharpes.reduce((a, x) => a + (x - avgTestSharpe) ** 2, 0) / testSharpes.length
  )

  const avgTrainPnl = windows.reduce((a, w) => a + w.trainReport.totalPnl, 0) / windows.length
  const avgTestPnl  = windows.reduce((a, w) => a + w.testReport.totalPnl, 0)  / windows.length

  const trainToTestPnlRatio = avgTestPnl !== 0
    ? avgTrainPnl / avgTestPnl
    : (avgTrainPnl !== 0 ? Infinity : 0)

  const consistencyScore = Math.abs(avgTestSharpe) > 0
    ? Math.max(0, 1 - stdTestSharpe / Math.abs(avgTestSharpe))
    : 0

  return {
    windows,
    avgTestSharpe,
    stdTestSharpe,
    avgTrainPnl,
    avgTestPnl,
    trainToTestPnlRatio,
    consistencyScore,
  }
}
