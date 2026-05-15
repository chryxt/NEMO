/**
 * Replay-driven signal research session.
 *
 * Runs a full signal computation pipeline over a replay (file or DB),
 * collects all signal frames, runs statistical validation, and exports results.
 *
 * Usage:
 *   const session = new ResearchSession(source, outputDir, speedMultiplier)
 *   const report  = await session.run()
 */
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { EventReplayer } from '../replay/EventReplayer.js'
import { DbReplayer } from '../replay/DbReplayer.js'
import { SignalEngine } from '../signals/SignalEngine.js'
import { SignalObserver } from './SignalObserver.js'
import { StatValidator } from './StatValidator.js'
import { ExportPipeline } from './ExportPipeline.js'
import type { SignalFrame, ResearchReport, MarketRegime } from '../signals/types.js'
import type { MarketSymbol } from '../types/market.js'
import { SYMBOLS } from '../types/market.js'

export type ReplaySource =
  | { type: 'file'; path: string }
  | { type: 'db'; from: Date; to?: Date }

// Memory guard: warn if collecting too many frames
const MAX_FRAMES_WARN = 500_000

export class ResearchSession {
  private readonly sessionId: string
  private frames: SignalFrame[] = []

  constructor(
    private readonly source:    ReplaySource,
    private readonly outputDir: string,
    private readonly speed:     number = 0,  // 0 = instant (fastest for research)
  ) {
    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  }

  async run(): Promise<ResearchReport> {
    log.info('[ResearchSession] starting', {
      sessionId: this.sessionId,
      source:    this.source.type,
      speed:     this.speed === 0 ? 'instant' : `${this.speed}×`,
      outputDir: this.outputDir,
    })

    // ── 1. Start signal pipeline ────────────────────────────────────────────
    const engine   = new SignalEngine()
    const observer = new SignalObserver()

    engine.start()
    observer.start()

    // Collect all signal frames emitted during replay
    bus.on('signal.frame', ({ frame }) => {
      if (this.frames.length >= MAX_FRAMES_WARN && this.frames.length % 10_000 === 0) {
        log.warn(`[ResearchSession] ${this.frames.length} frames in memory — consider shorter replay range`)
      }
      this.frames.push(frame)
    })

    // ── 2. Replay events ────────────────────────────────────────────────────
    const replayStart = Date.now()

    if (this.source.type === 'file') {
      const replayer = new EventReplayer(this.source.path, this.speed)
      await replayer.start()
    } else {
      const replayer = new DbReplayer({
        from:  this.source.from,
        to:    this.source.to,
        speed: this.speed,
      })
      await replayer.start()
    }

    const replayMs = Date.now() - replayStart
    log.info(`[ResearchSession] replay complete — ${this.frames.length} frames in ${(replayMs / 1000).toFixed(1)}s`)

    if (this.frames.length === 0) {
      log.warn('[ResearchSession] no signal frames collected — check that replay file contains oracle.price events')
      return this.emptyReport()
    }

    // ── 3. Statistical validation ───────────────────────────────────────────
    log.info('[ResearchSession] running statistical validation...')
    const validator = new StatValidator()
    const stats = SYMBOLS.flatMap(sym => validator.validate(this.frames, sym))

    // ── 4. Regime distribution ──────────────────────────────────────────────
    const regimeCounts: Partial<Record<MarketRegime, number>> = {}
    for (const f of this.frames) {
      regimeCounts[f.regime] = (regimeCounts[f.regime] ?? 0) + 1
    }
    const regimeDist: Partial<Record<MarketRegime, number>> = {}
    for (const [r, n] of Object.entries(regimeCounts) as [MarketRegime, number][]) {
      regimeDist[r] = n / this.frames.length
    }

    // ── 5. Export ────────────────────────────────────────────────────────────
    const exporter = new ExportPipeline(this.outputDir)

    // Split by symbol for more useful CSVs
    for (const sym of SYMBOLS) {
      const symFrames = this.frames.filter(f => f.symbol === sym)
      if (symFrames.length === 0) continue
      await exporter.exportCsv(symFrames,   `${this.sessionId}_${sym}.csv`)
      await exporter.exportJsonl(symFrames, `${this.sessionId}_${sym}.jsonl`)
    }

    // ── 6. Build and export report ──────────────────────────────────────────
    const fromTs = this.frames[0]!.ts
    const toTs   = this.frames[this.frames.length - 1]!.ts

    const report: ResearchReport = {
      sessionId:    this.sessionId,
      replaySource: this.source.type,
      fromTs,
      toTs,
      frameCount:   this.frames.length,
      durationSecs: (toTs - fromTs) / 1000,
      stats,
      regimeDist,
      outputDir:    this.outputDir,
    }

    await exporter.exportReport(report, `${this.sessionId}_report.json`)

    // ── 7. Print summary ────────────────────────────────────────────────────
    this.printSummary(report, observer)

    return report
  }

  private printSummary(report: ResearchReport, observer: SignalObserver): void {
    const obs = observer.getMetrics()
    log.info('=== Research Report ===', {
      sessionId:    report.sessionId,
      frames:       report.frameCount,
      durationMins: (report.durationSecs / 60).toFixed(1),
      framesPerSec: obs.framesPerSec.toFixed(1),
      avgLatencyUs: obs.avgComputeLatencyUs.toFixed(0),
      highConfRate: (obs.highConfidenceRate * 100).toFixed(1) + '%',
    })

    log.info('Regime distribution:', Object.fromEntries(
      Object.entries(report.regimeDist).map(([k, v]) => [k, (v! * 100).toFixed(1) + '%'])
    ))

    // Summary table for each signal at 30s horizon
    for (const stat of report.stats) {
      const h30 = stat.horizons.find(h => h.horizon === 30_000)
      if (!h30 || h30.sampleN < 10) continue
      log.info(`Signal: ${stat.signalName} [${stat.symbol}]`, {
        samples:       h30.sampleN,
        hitRate30s:    (h30.hitRate * 100).toFixed(1) + '%',
        pearson30s:    h30.pearson.toFixed(3),
        persistence:   (stat.persistence * 100).toFixed(1) + '%',
        falsePositive: (stat.falsePositiveRate * 100).toFixed(1) + '%',
      })
    }

    log.info(`Output: ${report.outputDir}/${report.sessionId}_*.{csv,jsonl,json}`)
  }

  private emptyReport(): ResearchReport {
    return {
      sessionId:    this.sessionId,
      replaySource: this.source.type,
      fromTs:       0, toTs: 0,
      frameCount:   0, durationSecs: 0,
      stats: [], regimeDist: {},
      outputDir: this.outputDir,
    }
  }
}
