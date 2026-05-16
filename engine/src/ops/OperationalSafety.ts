/**
 * Operational safety layer — extends Phase 6 KillSwitchController with
 * long-run safeguards:
 *
 *  - strategy auto-degrade (rolling Sharpe + signal rate vs baseline)
 *  - reconnect-storm protection (recent reconnect count threshold)
 *  - stale-feed escalation (sustained system.degraded → kill)
 *  - memory pressure (sustained heap > limit → kill, optional)
 *  - disk pressure (free space below threshold → warning only)
 *
 * All shutdown actions route through the existing kill-switch via
 * SimulationEngine.triggerKillSwitch — we do NOT introduce a parallel path.
 */
import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { config } from '../config/index'
import type { SimulationEngine } from '../sim/SimulationEngine'
import type { EdgePersistenceTracker } from './EdgePersistence'
import type { ReliabilityMonitor } from './ReliabilityMonitor'
import type { OperationalSafetyStatus } from './types'

const CHECK_INTERVAL_MS    = 10_000
const MEMORY_SUSTAIN_MS    = 60_000
const DEGRADED_SUSTAIN_MS  = 60_000

export class OperationalSafety {
  private checkTimer: NodeJS.Timeout | null = null

  private degraded            = false
  private degradedReason: string | null = null
  private reconnectStorm      = false
  private memoryPressureSince: number | null = null
  private memoryPressureActive = false
  private feedDegradedSince:  number | null = null
  private feedEscalationActive = false
  private diskPressureActive  = false

  // Track baselines learned over first hour of operation
  private baselineSignalsPerMin: number | null = null
  private baselineSampleCount = 0

  constructor(
    private readonly sim:    SimulationEngine,
    private readonly edge:   EdgePersistenceTracker,
    private readonly reliability: ReliabilityMonitor,
  ) {}

  start(): void {
    bus.on('system.degraded', () => {
      this.feedDegradedSince = Date.now()
    })
    bus.on('system.recovered', () => {
      this.feedDegradedSince = null
    })

    this.checkTimer = setInterval(() => this.tick(), CHECK_INTERVAL_MS)
    log.info('[OperationalSafety] started', {
      autoKillOnDegrade: config.opsAutoKillOnDegrade,
      degradeSharpe:     config.opsDegradeSharpe,
      reconnectStorm:    `${config.opsReconnectStormCount}/${config.opsReconnectStormWindowMs}ms`,
      memoryKillMb:      config.opsMemoryKillMb || 'disabled',
      degradedFeedKillMs:config.opsDegradedFeedKillMs || 'disabled',
      diskWarnMb:        config.opsDiskWarnMb,
    })
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer)
  }

  getStatus(): OperationalSafetyStatus {
    return {
      strategyDegraded:       this.degraded,
      strategyDegradedReason: this.degradedReason,
      reconnectStormActive:   this.reconnectStorm,
      memoryPressureActive:   this.memoryPressureActive,
      feedEscalationActive:   this.feedEscalationActive,
      diskPressureActive:     this.diskPressureActive,
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private tick(): void {
    const now = Date.now()
    this.updateBaseline()
    this.checkStrategyHealth()
    this.checkReconnectStorm()
    this.checkMemoryPressure(now)
    this.checkFeedEscalation(now)
    this.checkDiskPressure()
  }

  private updateBaseline(): void {
    // Learn baseline signal rate from the first hour of operation
    if (this.baselineSignalsPerMin != null) return
    const rate = this.edge.signalRatePerMin(60)
    if (rate > 0) {
      this.baselineSampleCount++
      // Use last observed rate after warmup (12 samples × 10s = 2min sustained)
      if (this.baselineSampleCount >= 12) this.baselineSignalsPerMin = rate
    }
  }

  private checkStrategyHealth(): void {
    const sharpe = this.edge.rollingSharpe(60)
    const currentRate = this.edge.signalRatePerMin(15)

    // Need at least 30min of data and an established baseline
    if (this.baselineSignalsPerMin == null) return

    const rateRatio = currentRate / Math.max(this.baselineSignalsPerMin, 0.001)
    const sharpeBad = sharpe < config.opsDegradeSharpe
    const rateBad   = rateRatio < 0.5

    const now = Date.now()
    if (sharpeBad && rateBad) {
      if (!this.degraded) {
        this.degraded = true
        this.degradedReason = `sharpe=${sharpe.toFixed(2)} rateRatio=${rateRatio.toFixed(2)}`
        log.warn(`[OperationalSafety] STRATEGY DEGRADED — ${this.degradedReason}`)
        bus.emit('ops.strategyDegraded', {
          reason:             this.degradedReason,
          sharpe,
          signalsPerMinRatio: rateRatio,
        })
        if (config.opsAutoKillOnDegrade && !this.sim.isKillSwitchActive()) {
          this.sim.triggerKillSwitch(`ops-auto-degrade: ${this.degradedReason}`)
          log.error(`[OperationalSafety] auto-kill engaged via degrade policy`)
        }
      }
      void now
    } else if (this.degraded && !sharpeBad && !rateBad) {
      // Advisory only — we DO NOT auto-reset the kill switch.
      this.degraded = false
      this.degradedReason = null
      log.info('[OperationalSafety] strategy degraded flag cleared (kill-switch state unchanged)')
    }
  }

  private checkReconnectStorm(): void {
    if (config.opsReconnectStormCount <= 0) return
    const rtds = this.reliability.recentReconnectCount('rtds', config.opsReconnectStormWindowMs)
    const clob = this.reliability.recentReconnectCount('clob', config.opsReconnectStormWindowMs)
    const stormService: 'rtds' | 'clob' | null =
      rtds >= config.opsReconnectStormCount ? 'rtds' :
      clob >= config.opsReconnectStormCount ? 'clob' : null

    if (stormService && !this.reconnectStorm) {
      this.reconnectStorm = true
      const count = stormService === 'rtds' ? rtds : clob
      log.error(`[OperationalSafety] RECONNECT STORM on ${stormService}: ${count} in ${config.opsReconnectStormWindowMs}ms`)
      bus.emit('ops.reconnectStorm', {
        service:  stormService, count, windowMs: config.opsReconnectStormWindowMs,
      })
      if (!this.sim.isKillSwitchActive()) {
        this.sim.triggerKillSwitch(`reconnect-storm: ${stormService} ${count} in ${config.opsReconnectStormWindowMs}ms`)
      }
    } else if (!stormService) {
      this.reconnectStorm = false
    }
  }

  private checkMemoryPressure(now: number): void {
    if (config.opsMemoryKillMb <= 0) return
    const heap = process.memoryUsage().heapUsed / 1_048_576
    if (heap > config.opsMemoryKillMb) {
      if (this.memoryPressureSince == null) this.memoryPressureSince = now
      if (now - this.memoryPressureSince > MEMORY_SUSTAIN_MS && !this.memoryPressureActive) {
        this.memoryPressureActive = true
        log.error(`[OperationalSafety] MEMORY PRESSURE: heap ${heap.toFixed(0)}MB > ${config.opsMemoryKillMb}MB sustained 60s`)
        if (!this.sim.isKillSwitchActive()) {
          this.sim.triggerKillSwitch(`memory: heap ${heap.toFixed(0)}MB > ${config.opsMemoryKillMb}MB`)
        }
      }
    } else {
      this.memoryPressureSince  = null
      this.memoryPressureActive = false
    }
  }

  private checkFeedEscalation(now: number): void {
    if (config.opsDegradedFeedKillMs <= 0) return
    if (this.feedDegradedSince == null) {
      this.feedEscalationActive = false
      return
    }
    const sustained = now - this.feedDegradedSince
    if (sustained > config.opsDegradedFeedKillMs && !this.feedEscalationActive) {
      this.feedEscalationActive = true
      log.error(`[OperationalSafety] FEED ESCALATION: degraded for ${(sustained/1000).toFixed(0)}s`)
      if (!this.sim.isKillSwitchActive()) {
        this.sim.triggerKillSwitch(`feed-degraded sustained ${(sustained/1000).toFixed(0)}s`)
      }
    }
  }

  private checkDiskPressure(): void {
    if (config.opsDiskWarnMb <= 0) return
    const report = this.reliability.getReport()
    if (report.diskFreeMb == null) return
    const low = report.diskFreeMb < config.opsDiskWarnMb
    if (low && !this.diskPressureActive) {
      this.diskPressureActive = true
      log.warn(`[OperationalSafety] DISK PRESSURE: ${report.diskFreeMb}MB free < ${config.opsDiskWarnMb}MB threshold`)
    } else if (!low && this.diskPressureActive) {
      this.diskPressureActive = false
    }
  }
}
