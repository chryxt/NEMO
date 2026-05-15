/**
 * Multi-source emergency halt for Phase 9 execution.
 *
 * Halt triggers (any one):
 *   - Operator console HALT command
 *   - Halt file present at EXECUTION_HALT_FILE (polled every 5s)
 *   - RPC health degraded (block lag / gas spike / RPC unreachable)
 *   - Nonce desync detected
 *   - SimulationEngine kill-switch active
 *
 * Once halted, the gateway refuses to submit. No auto-reset. An operator
 * may clear the halt by deleting the halt file AND issuing 'RESUME'
 * (RESUME is disabled in this phase as a deliberate safety measure).
 */
import { existsSync } from 'fs'
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'

const POLL_MS = 5_000

export type HaltSource =
  | 'operator-console'
  | 'halt-file'
  | 'rpc-degraded'
  | 'nonce-desync'
  | 'sim-kill-switch'
  | 'manual-api'

export class EmergencyHalt {
  private active     = false
  private source:    HaltSource | null = null
  private reason:    string | null = null
  private timer:     NodeJS.Timeout | null = null

  start(): void {
    if (config.executionHaltFile) {
      this.timer = setInterval(() => this.checkFile(), POLL_MS)
      this.checkFile()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  trigger(source: HaltSource, reason: string): void {
    if (this.active) return
    this.active = true
    this.source = source
    this.reason = reason
    log.error(`[EmergencyHalt] HALT ACTIVATED via ${source}: ${reason}`)
    bus.emit('execution.haltActivated', { source, reason })
  }

  isActive(): boolean { return this.active }
  getSource(): HaltSource | null { return this.source }
  getReason(): string | null { return this.reason }

  // ── Internal ────────────────────────────────────────────────────────────────

  private checkFile(): void {
    if (this.active) return
    if (!config.executionHaltFile) return
    if (existsSync(config.executionHaltFile)) {
      this.trigger('halt-file', `halt file present: ${config.executionHaltFile}`)
    }
  }
}
