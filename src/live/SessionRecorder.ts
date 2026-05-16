/**
 * Live session recorder — forensic JSONL recording for live paper sessions.
 *
 * Records to ./live-sessions/<timestamp>.jsonl with mixed record types:
 *   {"type":"event","ts":...,"event":"oracle.price","payload":{...}}
 *   {"type":"snapshot","ts":...,"portfolio":{...},"health":{...},"drift":{...}}
 *   {"type":"kill","ts":...,"status":{...}}
 *
 * Uses bus.tapMany to capture all events; coexists with EventRecorder.
 * Periodic snapshots are taken every SNAPSHOT_INTERVAL_MS.
 */
import { createWriteStream, mkdirSync } from 'fs'
import type { WriteStream } from 'fs'
import { join } from 'path'
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import type { SimulationEngine } from '../sim/SimulationEngine.js'
import type { StrategyHealthMonitor } from './StrategyHealth.js'
import type { DriftDetector } from './DriftDetector.js'
import type { KillSwitchController } from './KillSwitchController.js'

const FLUSH_EVERY        = 1_000     // events
const FLUSH_INTERVAL_MS  = 5_000
const SNAPSHOT_INTERVAL_MS = 10_000

// Events deemed too high-frequency or derived — drop from session record
const SKIP_EVENTS = new Set([
  'state.snapshot',    // derived, large
  'market.tick',       // 1/sec, derived
])

interface SessionDeps {
  sim:    SimulationEngine
  health: StrategyHealthMonitor
  drift:  DriftDetector
  kill:   KillSwitchController
}

export class SessionRecorder {
  private stream:   WriteStream | null = null
  private buffer:   string[]            = []
  private count                       = 0
  private flushTimer:    NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private lastKillState                       = false
  private path = ''

  constructor(
    private readonly outputDir: string,
    private readonly deps: SessionDeps,
  ) {}

  start(): void {
    mkdirSync(this.outputDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    this.path = join(this.outputDir, `live-${ts}.jsonl`)
    this.stream = createWriteStream(this.path, { flags: 'a' })

    bus.tapMany((event, payload) => {
      if (SKIP_EVENTS.has(event)) return
      this.write({ type: 'event', ts: Date.now(), event, payload })
    })

    this.flushTimer    = setInterval(() => this.flush(),    FLUSH_INTERVAL_MS)
    this.snapshotTimer = setInterval(() => this.snapshot(), SNAPSHOT_INTERVAL_MS)

    log.info(`[SessionRecorder] recording live session → ${this.path}`)
  }

  stop(): void {
    if (this.flushTimer)    clearInterval(this.flushTimer)
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    this.snapshot()  // final snapshot
    this.flush()
    if (this.stream) this.stream.end()
    log.info(`[SessionRecorder] closed — ${this.count} records written to ${this.path}`)
  }

  private write(record: unknown): void {
    this.buffer.push(JSON.stringify(record))
    this.count++
    if (this.buffer.length >= FLUSH_EVERY) this.flush()
  }

  private flush(): void {
    if (this.buffer.length === 0 || !this.stream) return
    this.stream.write(this.buffer.join('\n') + '\n')
    this.buffer = []
  }

  private snapshot(): void {
    const ts = Date.now()
    const portfolio = this.deps.sim.getPortfolio().snapshot(this.deps.sim.isKillSwitchActive())
    const health    = this.deps.health.getMetrics()
    const drift     = this.deps.drift.getReport()
    const kill      = this.deps.kill.getStatus()

    this.write({
      type: 'snapshot',
      ts,
      portfolio,
      health,
      drift,
      counts: this.deps.sim.getSummaryCounts(),
    })

    // Detect kill state transition
    if (kill.active !== this.lastKillState) {
      this.write({ type: 'kill', ts, status: kill })
      this.lastKillState = kill.active
    }
  }
}
