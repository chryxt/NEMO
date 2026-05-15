/**
 * Operational risk monitor — tracks pre-execution failure modes that would
 * affect real-market execution if it were enabled. All checks are
 * observation-only in this phase.
 *
 * Risk kinds tracked:
 *  - signing-failure        : EIP712Signer.dryRunSign threw
 *  - nonce-desync           : reported by a caller when expected nonce != actual
 *  - rpc-instability        : not measured in this phase (placeholder)
 *  - gas-anomaly            : not measured in this phase (placeholder)
 *  - exchange-api-degraded  : routed from system.degraded events
 *  - websocket-divergence   : routed from connection.change reconnects
 *
 * Emits shadow.riskFlag for every observed flag.
 */
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { RingBuffer } from '../utils/RingBuffer.js'
import type {
  RiskFlag, RiskFlagKind, OperationalRiskStatus,
} from './types.js'

const RECENT_FLAG_BUFFER = 100
const RECONNECT_DIVERGENCE_THRESHOLD = 3   // 3+ reconnects in 5 min = divergence

export class OperationalRiskMonitor {
  private readonly flags = new RingBuffer<RiskFlag>(RECENT_FLAG_BUFFER)
  private signingFailures = 0
  private nonceMismatches = 0
  private recentReconnects: number[] = []

  start(): void {
    bus.on('system.degraded', (e) => {
      this.recordFlag('exchange-api-degraded', `system.degraded: ${e.reason}`)
    })

    bus.on('connection.change', (e) => {
      if (e.status === 'reconnecting') {
        this.recentReconnects.push(Date.now())
        const cutoff = Date.now() - 5 * 60_000
        this.recentReconnects = this.recentReconnects.filter(t => t >= cutoff)
        if (this.recentReconnects.length >= RECONNECT_DIVERGENCE_THRESHOLD) {
          this.recordFlag('websocket-divergence',
            `${e.service} reconnects ${this.recentReconnects.length} in 5min`)
        }
      }
    })

    log.info('[OperationalRiskMonitor] started')
  }

  recordFlag(kind: RiskFlagKind, detail: string): void {
    const flag: RiskFlag = { kind, ts: Date.now(), detail }
    this.flags.push(flag)
    if (kind === 'signing-failure') this.signingFailures++
    if (kind === 'nonce-desync')    this.nonceMismatches++
    bus.emit('shadow.riskFlag', { kind, detail })
    log.warn(`[OperationalRisk] ${kind} — ${detail}`)
  }

  getStatus(): OperationalRiskStatus {
    const cutoff = Date.now() - 60 * 60_000
    const recent = this.flags.toArray().filter(f => f.ts >= cutoff)
    const byKind: Partial<Record<RiskFlagKind, number>> = {}
    for (const f of recent) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1

    return {
      flagsLastHour:   recent.length,
      byKind,
      recent:          this.flags.toArray().slice(-20),
      signingFailures: this.signingFailures,
      nonceMismatches: this.nonceMismatches,
    }
  }
}
