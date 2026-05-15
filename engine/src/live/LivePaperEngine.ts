/**
 * LivePaperEngine — top-level orchestrator for Phase 6.
 *
 * Bundles together SimulationEngine (paper execution, unchanged from Phase 4)
 * with the live-mode observability layer: strategy health, drift detection,
 * alert management, kill-switch control, and session recording.
 *
 * Does NOT connect to any exchange. Does NOT submit real orders.
 * Pure observability + simulation against live WS data.
 */
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'
import { SimulationEngine } from '../sim/SimulationEngine.js'
import { LatencyModel } from '../sim/LatencyModel.js'
import { CompositeStrategy } from '../strategies/CompositeStrategy.js'
import { WhaleFollowStrategy } from '../strategies/WhaleFollowStrategy.js'
import { StrategyHealthMonitor } from './StrategyHealth.js'
import { DriftDetector, loadBaseline } from './DriftDetector.js'
import { AlertManager } from './AlertManager.js'
import { KillSwitchController } from './KillSwitchController.js'
import { SessionRecorder } from './SessionRecorder.js'
import { OperationsEngine } from '../ops/OperationsEngine.js'
import { ShadowExecutionEngine } from '../shadow/ShadowExecutionEngine.js'
import { RingBuffer } from '../utils/RingBuffer.js'
import type { Strategy } from '../strategies/Strategy.js'
import type { LivePaperSnapshot } from './types.js'
import type { SimFill } from '../sim/types.js'

const RECENT_FILLS_CAPACITY = 5

export class LivePaperEngine {
  private readonly sim:           SimulationEngine
  private readonly health:        StrategyHealthMonitor
  private readonly drift:         DriftDetector
  private readonly alerts:        AlertManager
  private readonly killSwitch:    KillSwitchController
  private readonly recorder:      SessionRecorder | null
  private readonly ops:           OperationsEngine | null
  private readonly shadow:        ShadowExecutionEngine | null
  private readonly recentFills    = new RingBuffer<SimFill>(RECENT_FILLS_CAPACITY)
  private readonly fillsSeen      = new Set<string>()  // orderId set, prevent duplicate observation

  private started = false

  constructor(strategies?: Strategy[]) {
    const latency = new LatencyModel(
      config.simDecisionLatencyMs, config.simWsLatencyMs, config.simExecutionLatencyMs,
    )

    const strats = strategies ?? buildStrategiesFromConfig()
    this.sim    = new SimulationEngine(latency, strats)
    this.health = new StrategyHealthMonitor()

    const baseline = config.liveBaselineFile
      ? loadBaseline(config.liveBaselineFile)
      : null

    this.drift   = new DriftDetector(baseline)
    this.alerts  = new AlertManager()
    this.killSwitch = new KillSwitchController(this.sim)

    this.recorder = config.liveSessionRecord
      ? new SessionRecorder(config.liveSessionOutputDir, {
          sim:    this.sim,
          health: this.health,
          drift:  this.drift,
          kill:   this.killSwitch,
        })
      : null

    this.ops = config.opsEnabled
      ? new OperationsEngine(this.sim, this.health)
      : null

    this.shadow = config.shadowEnabled
      ? new ShadowExecutionEngine(this.sim)
      : null

    log.info('[LivePaperEngine] constructed', {
      strategies: strats.map(s => s.name).join('+'),
      latency:    latency.describe(),
      baseline:   config.liveBaselineFile || '(none)',
      recording:  config.liveSessionRecord,
      ops:        config.opsEnabled,
      shadow:     config.shadowEnabled,
    })
  }

  start(): void {
    if (this.started) return
    this.started = true

    // Sim must start before recorder so its initial events are taped
    this.sim.start()
    this.health.start()
    this.drift.start()
    this.alerts.start()
    this.killSwitch.start()

    // Observe fills for health/drift/snapshot (poll every second via market.tick)
    bus.on('market.tick', () => this.pollFills())

    if (this.recorder) this.recorder.start()
    if (this.ops)      this.ops.start()
    if (this.shadow)   this.shadow.start()
    log.info('[LivePaperEngine] started')
  }

  stop(): void {
    if (!this.started) return
    if (this.shadow)     this.shadow.stop()
    if (this.ops)        this.ops.stop()
    if (this.recorder)   this.recorder.stop()
    this.killSwitch.stop()
    this.sim.stop()
    log.info('[LivePaperEngine] stopped', this.sim.summary())
  }

  // ── Snapshot for Terminal rendering ────────────────────────────────────────

  snapshot(): LivePaperSnapshot {
    return {
      enabled:     true,
      portfolio:   this.sim.getPortfolio().snapshot(this.sim.isKillSwitchActive()),
      health:      this.health.getMetrics(),
      drift:       this.drift.getReport(),
      killSwitch:  this.killSwitch.getStatus(),
      recentFills: this.recentFills.toArray(),
      ops:         this.ops?.snapshot() ?? null,
      shadow:      this.shadow?.snapshot() ?? null,
    }
  }

  // ── Internal: poll new fills since last tick ────────────────────────────

  private pollFills(): void {
    const fills = this.sim.getPortfolio().getFills()
    for (const f of fills) {
      const key = `${f.orderId}:${f.ts}:${f.side}`
      if (this.fillsSeen.has(key)) continue
      this.fillsSeen.add(key)
      this.health.observeFill(f)
      this.drift.observeFill(f)
      this.recentFills.push(f)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildStrategiesFromConfig(): Strategy[] {
  const spec = config.simStrategy
  const names = spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const out: Strategy[] = []
  for (const name of names) {
    if (name === 'composite' || name === 'composite-signal') out.push(new CompositeStrategy())
    else if (name === 'whale' || name === 'whale-follow')    out.push(new WhaleFollowStrategy())
  }
  return out.length > 0 ? out : [new CompositeStrategy()]
}
