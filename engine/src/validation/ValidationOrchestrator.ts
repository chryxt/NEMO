/**
 * Validation orchestrator — runs a configurable suite of Phase 5 checks and
 * produces an aggregated ValidationReport plus per-section CSV exports.
 *
 * Suites:
 *   - 'sweep'        — parameter grid sweep only
 *   - 'walk-forward' — walk-forward analysis + overfit checks on its output
 *   - 'monte-carlo'  — MC stress test
 *   - 'scenarios'    — adversarial scenarios
 *   - 'compare'      — strategy comparison across latencies
 *   - 'full'         — all of the above (slow but thorough)
 *
 * All write paths land in `outputDir/<sessionId>_<section>.{json,csv}`.
 */
import { mkdirSync, createWriteStream } from 'fs'
import { join } from 'path'
import { log } from '../utils/logger'
import { config } from '../config/index'
import { LatencyModel } from '../sim/LatencyModel'
import { CompositeStrategy } from '../strategies/CompositeStrategy'
import { WhaleFollowStrategy } from '../strategies/WhaleFollowStrategy'
import { loadReplayFile } from './ReplayRunner'
import { runParameterSweep } from './ParameterSweep'
import { runWalkForward } from './WalkForwardRunner'
import { runMonteCarlo } from './MonteCarloRunner'
import { runScenarios } from './ScenarioRunner'
import { runComparator } from './StrategyComparator'
import { runOverfittingDetector } from './OverfittingDetector'
import type { ValidationReport, RecordedEvent } from './types'
import type { ParamGrid, StrategyFactory } from './ParameterSweep'

export type Suite = 'sweep' | 'walk-forward' | 'monte-carlo' | 'scenarios' | 'compare' | 'full'

export interface OrchestratorSpec {
  replayFile: string
  suite:      Suite
  outputDir:  string
}

// ── Default factories for sweep/walk-forward — composite strategy params ─────

function defaultCompositeGrid(): ParamGrid {
  return {
    minConfidence:         [0.5, 0.6, 0.7, 0.8],
    minAgreement:          [0.4, 0.6, 0.8],
    minSecondsBeforeClose: [10, 20, 30],
  }
}

function defaultStrategyFactory(): StrategyFactory {
  return (params) => [new CompositeStrategy({
    minConfidence:         params.minConfidence as number,
    minAgreement:          params.minAgreement as number,
    minSecondsBeforeClose: params.minSecondsBeforeClose as number,
  })]
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function runValidationSuite(spec: OrchestratorSpec): Promise<ValidationReport> {
  mkdirSync(spec.outputDir, { recursive: true })
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  log.info('[Validation] starting suite', {
    sessionId, suite: spec.suite, replay: spec.replayFile, output: spec.outputDir,
  })

  const events = loadReplayFile(spec.replayFile)
  log.info(`[Validation] loaded ${events.length} events from ${spec.replayFile}`)

  const baseLatency = new LatencyModel(
    config.simDecisionLatencyMs, config.simWsLatencyMs, config.simExecutionLatencyMs,
  )

  const report: ValidationReport = {
    sessionId,
    replaySource: spec.replayFile,
    generatedAt:  Date.now(),
    outputDir:    spec.outputDir,
  }

  // ── Parameter sweep ───────────────────────────────────────────────────────
  if (spec.suite === 'sweep' || spec.suite === 'full') {
    log.info('[Validation] === Parameter Sweep ===')
    const grid = defaultCompositeGrid()
    report.sweep = runParameterSweep({
      events,
      paramGrid:       grid,
      strategyFactory: defaultStrategyFactory(),
      latency:         baseLatency,
    })
    await writeJson(spec.outputDir, sessionId, 'sweep', report.sweep)
    await writeSweepCsv(spec.outputDir, sessionId, report.sweep)
  }

  // ── Walk-forward ──────────────────────────────────────────────────────────
  if (spec.suite === 'walk-forward' || spec.suite === 'full') {
    log.info('[Validation] === Walk-Forward ===')
    report.walkForward = runWalkForward({
      events,
      paramGrid:       defaultCompositeGrid(),
      strategyFactory: defaultStrategyFactory(),
      latency:         baseLatency,
      windowMs:        config.validationWfWindowMs,
      trainFraction:   config.validationWfTrainFraction,
      stepMs:          config.validationWfStepMs,
      minEventsPerWin: 100,
    })
    await writeJson(spec.outputDir, sessionId, 'walk-forward', report.walkForward)
    await writeWalkForwardCsv(spec.outputDir, sessionId, report.walkForward)
  }

  // ── Monte Carlo ───────────────────────────────────────────────────────────
  if (spec.suite === 'monte-carlo' || spec.suite === 'full') {
    log.info('[Validation] === Monte Carlo ===')
    report.monteCarlo = runMonteCarlo({
      events,
      strategies: [new CompositeStrategy()],
      latency:    baseLatency,
      perturbation: {
        latencyJitterMs:     config.validationMcLatencyJitterMs,
        whaleShiftMs:        config.validationMcWhaleShiftMs,
        spreadMultiplierStd: config.validationMcSpreadStd,
        slippageBpsExtra:    config.validationMcSlippageExtraBps,
      },
      numRuns:   config.validationMcRuns,
      baseSeed:  config.validationMcBaseSeed,
    })
    await writeJson(spec.outputDir, sessionId, 'monte-carlo', report.monteCarlo)
  }

  // ── Scenarios ─────────────────────────────────────────────────────────────
  if (spec.suite === 'scenarios' || spec.suite === 'full') {
    log.info('[Validation] === Scenarios ===')
    report.scenarios = runScenarios({
      events,
      strategies: [new CompositeStrategy()],
      latency:    baseLatency,
    })
    await writeJson(spec.outputDir, sessionId, 'scenarios', report.scenarios)
  }

  // ── Comparison ────────────────────────────────────────────────────────────
  if (spec.suite === 'compare' || spec.suite === 'full') {
    log.info('[Validation] === Strategy Comparison ===')
    report.comparison = runComparator({
      events,
      strategies: [
        { name: 'composite',    factory: () => [new CompositeStrategy()] },
        { name: 'whale-follow', factory: () => [new WhaleFollowStrategy()] },
        { name: 'hybrid',       factory: () => [new CompositeStrategy(), new WhaleFollowStrategy()] },
      ],
      latencies: [
        { tag: '10ms',  decisionMs: 1, wsMs: 9,   execMs: 0 },
        { tag: '50ms',  decisionMs: 5, wsMs: 40,  execMs: 5 },
        { tag: '100ms', decisionMs: 5, wsMs: 90,  execMs: 5 },
        { tag: '250ms', decisionMs: 5, wsMs: 240, execMs: 5 },
        { tag: '500ms', decisionMs: 5, wsMs: 490, execMs: 5 },
      ],
    })
    await writeJson(spec.outputDir, sessionId, 'comparison', report.comparison)
    await writeComparatorCsv(spec.outputDir, sessionId, report.comparison)
  }

  // ── Overfitting detector (uses outputs of sweep + walk-forward) ──────────
  if ((spec.suite === 'walk-forward' || spec.suite === 'full') && report.walkForward) {
    log.info('[Validation] === Overfitting Detector ===')
    report.overfitting = runOverfittingDetector({
      sweep:       report.sweep,
      walkForward: report.walkForward,
      truncCheck:  {
        events,
        strategies: [new CompositeStrategy()],
        latency:    baseLatency,
        truncFraction: 0.6,
      },
    })
    await writeJson(spec.outputDir, sessionId, 'overfitting', report.overfitting)
  }

  // ── Full report ───────────────────────────────────────────────────────────
  await writeJson(spec.outputDir, sessionId, 'report', report)
  printSummary(report)
  return report
}

// ── Export helpers ────────────────────────────────────────────────────────────

async function writeJson(dir: string, sessionId: string, section: string, data: unknown): Promise<string> {
  const path = join(dir, `${sessionId}_${section}.json`)
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(path)
    ws.on('error', reject); ws.on('finish', resolve)
    ws.write(JSON.stringify(data, null, 2) + '\n')
    ws.end()
  })
  log.info(`[Validation] wrote ${path}`)
  return path
}

async function writeSweepCsv(dir: string, sessionId: string, sweep: ValidationReport['sweep']): Promise<void> {
  if (!sweep) return
  const path = join(dir, `${sessionId}_sweep.csv`)
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(path)
    ws.on('error', reject); ws.on('finish', resolve)
    const paramKeys = Object.keys(sweep.paramGrid)
    ws.write([...paramKeys, 'pnl', 'sharpe', 'sortino', 'maxDrawdown', 'fills', 'winRate'].join(',') + '\n')
    for (const p of sweep.points) {
      const row = [
        ...paramKeys.map(k => String(p.params[k])),
        p.report.totalPnl.toFixed(2),
        p.metrics.sharpe.toFixed(3),
        p.metrics.sortino.toFixed(3),
        (p.metrics.maxDrawdown * 100).toFixed(2),
        p.report.fills,
        (p.report.winRate * 100).toFixed(2),
      ]
      ws.write(row.join(',') + '\n')
    }
    ws.end()
  })
  log.info(`[Validation] wrote ${path}`)
}

async function writeWalkForwardCsv(dir: string, sessionId: string, wf: ValidationReport['walkForward']): Promise<void> {
  if (!wf) return
  const path = join(dir, `${sessionId}_walk-forward.csv`)
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(path)
    ws.on('error', reject); ws.on('finish', resolve)
    ws.write('window,trainFromTs,trainToTs,testFromTs,testToTs,trainPnl,testPnl,testSharpe,testMaxDrawdown\n')
    for (const w of wf.windows) {
      ws.write([
        w.index, w.trainFromTs, w.trainToTs, w.testFromTs, w.testToTs,
        w.trainReport.totalPnl.toFixed(2),
        w.testReport.totalPnl.toFixed(2),
        w.testMetrics.sharpe.toFixed(3),
        (w.testMetrics.maxDrawdown * 100).toFixed(2),
      ].join(',') + '\n')
    }
    ws.end()
  })
  log.info(`[Validation] wrote ${path}`)
}

async function writeComparatorCsv(dir: string, sessionId: string, cmp: ValidationReport['comparison']): Promise<void> {
  if (!cmp) return
  const path = join(dir, `${sessionId}_comparison.csv`)
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(path)
    ws.on('error', reject); ws.on('finish', resolve)
    ws.write('strategy,latency,pnl,sharpe,sortino,maxDrawdown,winRate,fills,avgSlippageBps\n')
    for (const c of cmp.cells) {
      ws.write([
        c.strategyName, c.latencyTag,
        c.report.totalPnl.toFixed(2),
        c.metrics.sharpe.toFixed(3),
        c.metrics.sortino.toFixed(3),
        (c.metrics.maxDrawdown * 100).toFixed(2),
        (c.report.winRate * 100).toFixed(2),
        c.report.fills,
        c.report.avgSlippageBps.toFixed(2),
      ].join(',') + '\n')
    }
    ws.end()
  })
  log.info(`[Validation] wrote ${path}`)
}

function printSummary(report: ValidationReport): void {
  log.info('=== Validation Report ===', {
    sessionId: report.sessionId,
    outputDir: report.outputDir,
  })

  if (report.sweep && report.sweep.best) {
    log.info('Parameter sweep — best point', {
      params:  report.sweep.best.params,
      pnl:     `$${report.sweep.best.report.totalPnl.toFixed(2)}`,
      sharpe:  report.sweep.best.metrics.sharpe.toFixed(2),
      stability: report.sweep.stability.toFixed(3),
    })
  }
  if (report.walkForward) {
    log.info('Walk-forward', {
      windows:        report.walkForward.windows.length,
      avgTestSharpe:  report.walkForward.avgTestSharpe.toFixed(2),
      consistency:    report.walkForward.consistencyScore.toFixed(2),
      trainTestRatio: report.walkForward.trainToTestPnlRatio.toFixed(2),
    })
  }
  if (report.monteCarlo) {
    log.info('Monte Carlo', {
      numRuns:   report.monteCarlo.numRuns,
      pnlMean:   `$${report.monteCarlo.pnlMean.toFixed(2)}`,
      pnlStd:    `$${report.monteCarlo.pnlStd.toFixed(2)}`,
      pnlP5:     `$${report.monteCarlo.pnlP5.toFixed(2)}`,
      pnlP95:    `$${report.monteCarlo.pnlP95.toFixed(2)}`,
      pLoss:     `${(report.monteCarlo.probabilityOfLoss * 100).toFixed(1)}%`,
    })
  }
  if (report.scenarios) {
    log.info('Scenarios', {
      worstScenario: report.scenarios.worstScenario,
      worstDelta:    `$${report.scenarios.worstDelta.toFixed(2)}`,
      runs:          report.scenarios.runs.length,
    })
  }
  if (report.comparison && report.comparison.ranking.length > 0) {
    const top = report.comparison.ranking[0]!
    log.info('Comparison — top cell', {
      strategy: top.strategyName,
      latency:  top.latencyTag,
      pnl:      `$${top.report.totalPnl.toFixed(2)}`,
      sharpe:   top.metrics.sharpe.toFixed(2),
    })
  }
  if (report.overfitting) {
    log.info('Overfitting checks', {
      overallScore: report.overfitting.overallScore.toFixed(2),
      findings:     report.overfitting.findings.map(f => `${f.check}=${f.passed ? '✓' : '✗'}(${f.score.toFixed(2)})`).join('  '),
    })
  }
}
