/**
 * Multi-source kill-switch controller.
 *
 * Watches volatility, end-to-end latency, stale-feed events, and a manual
 * file flag. On any trigger, calls `sim.triggerKillSwitch(reason)`. The
 * SimulationEngine then rejects all new orders until explicitly reset.
 *
 * One-way activation per session. Manual reset only via `reset()` (not
 * exposed via bus to keep accidents impossible).
 */
import { existsSync } from 'fs'
import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { config } from '../config/index'
import { RingBuffer } from '../utils/RingBuffer'
import type { SimulationEngine } from '../sim/SimulationEngine'
import type { KillSwitchStatus } from './types'

const VOLATILITY_WINDOW_MS = 30_000   // sustained period before trigger
const LATENCY_WINDOW_MS    = 60_000
const MANUAL_POLL_MS       =  5_000
const LATENCY_SAMPLES_NEEDED = 30

interface TsValue { ts: number; v: number }

export class KillSwitchController {
  private triggeredBy:  string | null = null
  private triggeredAtMs:number | null = null

  // Rolling windows
  private volatilitySamples = new RingBuffer<TsValue>(300)  // signal frames
  private latencySamples    = new RingBuffer<TsValue>(500)  // oracle.price lag

  private manualPollTimer: NodeJS.Timeout | null = null

  constructor(private readonly sim: SimulationEngine) {}

  start(): void {
    bus.on('signal.frame', ({ frame }) => {
      const vol = frame.features.oracle.volatility30s
      if (vol == null) return
      const now = Date.now()
      this.volatilitySamples.push({ ts: now, v: vol })
      this.checkVolatility(now)
    })

    bus.on('oracle.price', (e) => {
      const now = Date.now()
      const lag = now - e.ts
      this.latencySamples.push({ ts: now, v: lag })
      this.checkLatency(now)
    })

    bus.on('system.degraded', (e) => {
      this.trigger('stale-feed', `feed degraded: ${e.reason}`)
    })

    bus.on('drift.alert', (e) => {
      // Multiple simultaneous critical drift metrics → trigger
      if (e.severity === 'critical') {
        this.trigger('drift', `critical drift on ${e.metric} (${(e.drift * 100).toFixed(1)}%)`)
      }
    })

    if (config.liveKillSwitchFile) {
      this.manualPollTimer = setInterval(() => {
        if (existsSync(config.liveKillSwitchFile)) {
          this.trigger('manual', `manual kill-switch file present: ${config.liveKillSwitchFile}`)
        }
      }, MANUAL_POLL_MS)
    }

    log.info('[KillSwitchController] started', {
      volThreshold:    config.liveKillSwitchVolatility,
      latencyThreshMs: config.liveKillSwitchLatencyMs,
      manualFile:      config.liveKillSwitchFile || '(disabled)',
    })
  }

  stop(): void {
    if (this.manualPollTimer) clearInterval(this.manualPollTimer)
  }

  reset(): void {
    this.sim.resetKillSwitch()
    this.triggeredBy = null
    this.triggeredAtMs = null
  }

  getStatus(): KillSwitchStatus {
    return {
      active:        this.sim.isKillSwitchActive(),
      reason:        this.sim.isKillSwitchActive() ? this.sim.getKillSwitchReason() : null,
      triggeredBy:   this.triggeredBy,
      triggeredAtMs: this.triggeredAtMs,
    }
  }

  // ── Private trigger logic ─────────────────────────────────────────────────

  private trigger(source: string, reason: string): void {
    if (this.sim.isKillSwitchActive()) return
    this.triggeredBy   = source
    this.triggeredAtMs = Date.now()
    this.sim.triggerKillSwitch(`${source}: ${reason}`)
    log.error(`[KillSwitch] triggered via ${source}: ${reason}`)
  }

  private checkVolatility(now: number): void {
    if (this.sim.isKillSwitchActive())           return
    if (config.liveKillSwitchVolatility <= 0)    return

    const cutoff = now - VOLATILITY_WINDOW_MS
    const arr = this.volatilitySamples.toArray().filter(s => s.ts >= cutoff)
    if (arr.length < 5) return

    const allOver = arr.every(s => s.v > config.liveKillSwitchVolatility)
    if (allOver) {
      const maxV = arr.reduce((m, s) => Math.max(m, s.v), 0)
      this.trigger('volatility', `volatility sustained above ${config.liveKillSwitchVolatility} for 30s (peak ${maxV.toExponential(2)})`)
    }
  }

  private checkLatency(now: number): void {
    if (this.sim.isKillSwitchActive())          return
    if (config.liveKillSwitchLatencyMs <= 0)    return

    const cutoff = now - LATENCY_WINDOW_MS
    const arr = this.latencySamples.toArray().filter(s => s.ts >= cutoff)
    if (arr.length < LATENCY_SAMPLES_NEEDED) return

    const sorted = [...arr].map(s => s.v).sort((a, b) => a - b)
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0
    if (p99 > config.liveKillSwitchLatencyMs) {
      this.trigger('latency', `p99 latency ${p99.toFixed(0)}ms sustained above ${config.liveKillSwitchLatencyMs}ms`)
    }
  }
}
