/**
 * OperationsEngine — Phase 7 orchestrator for long-running live paper sessions.
 *
 * Bundles together:
 *   - ReliabilityMonitor    (uptime, reconnects, memory, lag)
 *   - EdgePersistenceTracker (rolling Sharpe, hit-rate, decay, half-life)
 *   - DriftEvolutionAnalyzer (drift history, CUSUM structural-break)
 *   - DatasetCurator         (labeled JSONL for future ML)
 *   - OperationalSafety      (auto-degrade, storm guard, memory/disk pressure)
 *   - DailyReportWriter      (md/json/csv at UTC midnight)
 *   - LongHorizonAnalytics   (weekly/monthly roll-ups)
 *
 * Lifecycle is wall-clock based (observability layer — not in simulation
 * hot path). Daily rollover at UTC midnight, weekly on Monday UTC, monthly
 * on first day of month UTC.
 */
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'
import { ReliabilityMonitor } from './ReliabilityMonitor.js'
import { EdgePersistenceTracker } from './EdgePersistence.js'
import { DriftEvolutionAnalyzer } from './DriftEvolution.js'
import { DatasetCurator } from './DatasetCurator.js'
import { OperationalSafety } from './OperationalSafety.js'
import { DailyReportWriter } from './DailyReport.js'
import { LongHorizonAnalytics, weekTag, monthTag } from './LongHorizonAnalytics.js'
import type { SimulationEngine } from '../sim/SimulationEngine.js'
import type { StrategyHealthMonitor } from '../live/StrategyHealth.js'
import type { OpsSnapshot, DailyReport } from './types.js'

const ROLLOVER_CHECK_MS = 60_000   // check for date crossings every minute

export class OperationsEngine {
  private readonly reliability:  ReliabilityMonitor
  private readonly edge:         EdgePersistenceTracker
  private readonly drift:        DriftEvolutionAnalyzer
  private readonly curator:      DatasetCurator | null
  private readonly safety:       OperationalSafety
  private readonly daily:        DailyReportWriter
  private readonly longHorizon:  LongHorizonAnalytics

  private started        = false
  private startedAtMs    = 0
  private currentDateUtc = ''
  private currentWeekTag = ''
  private currentMonthTag = ''
  private rolloverTimer: NodeJS.Timeout | null = null

  // Daily counters (reset on UTC rollover)
  private daySignalCount     = 0
  private daySumConfidence   = 0
  private daySumComputeUs    = 0
  private dayRegimeMix:      Record<string, number> = {}
  private dayDriftAlerts     = 0
  private dayCriticalDrift   = 0
  private dayStructuralBreaks = 0
  private dayWhaleCount      = 0
  private dayWhaleUsd        = 0

  constructor(
    private readonly sim:    SimulationEngine,
    private readonly health: StrategyHealthMonitor,   // reused from Phase 6 for regime mix
  ) {
    this.reliability  = new ReliabilityMonitor()
    this.edge         = new EdgePersistenceTracker(sim)
    this.drift        = new DriftEvolutionAnalyzer(config.opsCusumK, config.opsCusumH)
    this.curator      = config.opsDatasetEnabled ? new DatasetCurator(config.opsOutputDir, sim) : null
    this.safety       = new OperationalSafety(sim, this.edge, this.reliability)
    this.daily        = new DailyReportWriter(config.opsOutputDir)
    this.longHorizon  = new LongHorizonAnalytics(config.opsOutputDir)
  }

  start(): void {
    if (this.started) return
    this.started     = true
    this.startedAtMs = Date.now()
    this.currentDateUtc  = dateUtc(this.startedAtMs)
    this.currentWeekTag  = weekTag(new Date(this.startedAtMs))
    this.currentMonthTag = monthTag(new Date(this.startedAtMs))

    this.reliability.start(config.opsReliabilitySampleMs)
    this.edge.start(config.opsEquitySampleMs)
    this.drift.start()
    if (this.curator) this.curator.start()
    this.safety.start()

    // Daily counters
    bus.on('signal.frame', ({ frame, latencyUs }) => {
      this.daySignalCount++
      this.daySumConfidence += frame.composite.confidence
      this.daySumComputeUs  += latencyUs
      this.dayRegimeMix[frame.regime] = (this.dayRegimeMix[frame.regime] ?? 0) + 1
    })

    bus.on('drift.alert', (e) => {
      this.dayDriftAlerts++
      if (e.severity === 'critical') this.dayCriticalDrift++
    })

    bus.on('ops.structuralBreak', () => { this.dayStructuralBreaks++ })

    bus.on('whale.alert', (e) => {
      this.dayWhaleCount++
      this.dayWhaleUsd += e.trade.sizeUsd
    })

    this.rolloverTimer = setInterval(() => this.checkRollovers(), ROLLOVER_CHECK_MS)

    log.info('[OperationsEngine] started', {
      outputDir:        config.opsOutputDir,
      dataset:          config.opsDatasetEnabled,
      sampleMs:         config.opsReliabilitySampleMs,
      equitySampleMs:   config.opsEquitySampleMs,
      cusum:            `K=${config.opsCusumK} H=${config.opsCusumH}`,
      startedAt:        new Date(this.startedAtMs).toISOString(),
    })
  }

  stop(): void {
    if (!this.started) return
    // Finalize partial day on shutdown
    try { this.finalizeDay(this.currentDateUtc) } catch (err) {
      log.error(`[OperationsEngine] failed to finalize day on shutdown: ${(err as Error).message}`)
    }
    if (this.rolloverTimer) clearInterval(this.rolloverTimer)
    this.safety.stop()
    if (this.curator) this.curator.stop()
    this.reliability.stop()
    this.edge.stop()
    this.started = false
    log.info('[OperationsEngine] stopped')
  }

  snapshot(): OpsSnapshot {
    return {
      enabled:        this.started,
      startedAtMs:    this.startedAtMs,
      currentDateUtc: this.currentDateUtc,
      edge:           this.edge.getReport(),
      drift:          this.drift.getReport(),
      reliability:    this.reliability.getReport(),
      safety:         this.safety.getStatus(),
      reportsWritten: this.daily.getWriteCount(),
      datasetRecords: this.curator?.getRecordCount() ?? 0,
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private checkRollovers(): void {
    const now = Date.now()
    const today = dateUtc(now)
    if (today !== this.currentDateUtc) {
      const closing = this.currentDateUtc
      try { this.finalizeDay(closing) } catch (err) {
        log.error(`[OperationsEngine] day rollover failed: ${(err as Error).message}`)
      }
      this.currentDateUtc = today
      this.resetDayCounters()
      log.info(`[OperationsEngine] rolled over to ${today}`)
    }

    const thisWeek  = weekTag(new Date(now))
    const thisMonth = monthTag(new Date(now))
    if (thisWeek !== this.currentWeekTag) {
      try { this.finalizeWeek(this.currentWeekTag) } catch (err) {
        log.error(`[OperationsEngine] week rollover failed: ${(err as Error).message}`)
      }
      this.currentWeekTag = thisWeek
    }
    if (thisMonth !== this.currentMonthTag) {
      try { this.finalizeMonth(this.currentMonthTag) } catch (err) {
        log.error(`[OperationsEngine] month rollover failed: ${(err as Error).message}`)
      }
      this.currentMonthTag = thisMonth
    }
  }

  private finalizeDay(dateStr: string): void {
    const bucket = this.edge.rolloverDay()
    const portfolio = this.sim.getPortfolio().snapshot(this.sim.isKillSwitchActive())
    const reliability = this.reliability.getReport()
    const safety = this.safety.getStatus()
    const driftReport = this.drift.getReport()

    const avgConf   = this.daySignalCount > 0 ? this.daySumConfidence / this.daySignalCount : 0
    const avgCompute = this.daySignalCount > 0 ? this.daySumComputeUs  / this.daySignalCount : 0

    const report: DailyReport = {
      dateUtc:        dateStr,
      generatedAtMs:  Date.now(),
      sessionStartMs: this.startedAtMs,
      sessionEndMs:   Date.now(),
      portfolio,
      edge: {
        netPnlUsd:    bucket.netPnlUsd,
        closedTrades: bucket.closedTrades,
        winRate:      bucket.hitRate,
        sharpe:       bucket.sharpe,
        drawdown:     portfolio.drawdown,
      },
      signals: {
        count:         this.daySignalCount,
        avgConfidence: avgConf,
        avgComputeUs:  avgCompute,
        regimeMix:     { ...this.dayRegimeMix },
      },
      drift: {
        alertCount:       this.dayDriftAlerts,
        criticalCount:    this.dayCriticalDrift,
        structuralBreaks: this.dayStructuralBreaks,
      },
      reliability,
      safety,
      whales: {
        count:    this.dayWhaleCount,
        totalUsd: this.dayWhaleUsd,
      },
    }

    this.daily.write(report)
    // Suppress unused warnings (we keep references for potential extension)
    void this.health
    void driftReport
  }

  private finalizeWeek(weekId: string): void {
    if (!weekId) return
    const all = this.longHorizon.loadAllDailyReports()
    // pick days whose week matches
    const weekDays = all.filter(d => weekTag(new Date(`${d.dateUtc}T12:00:00Z`)) === weekId)
    if (weekDays.length > 0) this.longHorizon.writeWeekly(weekId, weekDays)
  }

  private finalizeMonth(monthId: string): void {
    if (!monthId) return
    const all = this.longHorizon.loadAllDailyReports()
    const monthDays = all.filter(d => d.dateUtc.startsWith(monthId))
    if (monthDays.length > 0) this.longHorizon.writeMonthly(monthId, monthDays)
  }

  private resetDayCounters(): void {
    this.daySignalCount      = 0
    this.daySumConfidence    = 0
    this.daySumComputeUs     = 0
    this.dayRegimeMix        = {}
    this.dayDriftAlerts      = 0
    this.dayCriticalDrift    = 0
    this.dayStructuralBreaks = 0
    this.dayWhaleCount       = 0
    this.dayWhaleUsd         = 0
  }
}

function dateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
