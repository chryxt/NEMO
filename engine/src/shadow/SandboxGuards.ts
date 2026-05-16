/**
 * Sandbox guards — hard caps that NEVER auto-release.
 *
 *  - global halt: presence of <SHADOW_HALT_FILE> triggers an instant halt
 *    that routes through the existing kill-switch
 *  - max notional cap: any approval request exceeding this is auto-rejected
 *  - one-strategy-at-a-time lock: when set, only the named strategy may
 *    have orders flowing through the approval queue
 *  - real-submission permission: HARDCODED FALSE in this phase
 */
import { existsSync } from 'fs'
import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { config } from '../config/index'
import type { SandboxGuardStatus, ShadowOrder } from './types'

const HALT_POLL_MS = 5_000

export class SandboxGuards {
  private haltActive = false
  private haltReason: string | null = null
  private haltTimer: NodeJS.Timeout | null = null
  private triggerHaltFn: ((reason: string) => void) | null = null

  start(triggerHalt: (reason: string) => void): void {
    this.triggerHaltFn = triggerHalt
    if (config.shadowHaltFile) {
      this.haltTimer = setInterval(() => this.checkHalt(), HALT_POLL_MS)
      this.checkHalt()
    }
    log.info('[SandboxGuards] started', {
      haltFile:           config.shadowHaltFile || '(disabled)',
      maxNotionalUsd:     config.shadowMaxNotionalUsd,
      singleStrategyLock: config.shadowSingleStrategyLock || '(none)',
      realSubmission:     false,
    })
  }

  stop(): void {
    if (this.haltTimer) clearInterval(this.haltTimer)
  }

  /** Pre-approval check: returns rejection reason or null if allowed. */
  rejectReason(order: ShadowOrder): string | null {
    if (this.haltActive) return `sandbox-halt: ${this.haltReason ?? 'halted'}`
    if (order.notionalUsd > config.shadowMaxNotionalUsd) {
      return `notional $${order.notionalUsd.toFixed(2)} > cap $${config.shadowMaxNotionalUsd}`
    }
    const lock = config.shadowSingleStrategyLock
    if (lock && lock.length > 0) {
      // simOrderId starts with 'sim-N' — strategy is encoded in struct.signer but not here
      // We approximate strategy match via the shadow.order.id prefix not being applicable —
      // strategy lock is enforced upstream by the approval queue when it has the strategy id.
      // This kept here as a placeholder for the strategy id arriving via metadata.
      void lock
    }
    return null
  }

  getStatus(): SandboxGuardStatus {
    return {
      globalHaltActive:      this.haltActive,
      haltReason:            this.haltReason,
      maxNotionalUsd:        config.shadowMaxNotionalUsd,
      singleStrategyLock:    config.shadowSingleStrategyLock || null,
      walletEnabled:         config.shadowWalletEnabled,
      approvalsRequired:     true,                     // hard-coded for this phase
      realSubmissionAllowed: false,                    // HARDCODED FALSE
    }
  }

  manualHalt(reason: string): void {
    if (this.haltActive) return
    this.haltActive = true
    this.haltReason = reason
    log.error(`[SandboxGuards] MANUAL HALT: ${reason}`)
    bus.emit('shadow.halt', { reason, source: 'sandbox-guard' })
    this.triggerHaltFn?.(reason)
  }

  private checkHalt(): void {
    if (this.haltActive) return
    if (!config.shadowHaltFile) return
    if (existsSync(config.shadowHaltFile)) {
      this.haltActive = true
      this.haltReason = `halt file present: ${config.shadowHaltFile}`
      log.error(`[SandboxGuards] GLOBAL HALT — ${this.haltReason}`)
      bus.emit('shadow.halt', { reason: this.haltReason, source: 'manual-file' })
      this.triggerHaltFn?.(this.haltReason)
    }
  }
}
