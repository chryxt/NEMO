/**
 * Approval queue — file-backed JSONL queue of pending shadow orders.
 *
 *  - On a new shadow order, write a pending entry to <queueFile>
 *  - Periodically scan the file for entries marked 'approved' or 'rejected'
 *    by the operator (manual edit) and pick them up
 *  - Auto-expire entries past their expiresAtMs
 *
 * The on-disk file is the source of truth so an operator can edit it with
 * any text editor or scripted approval tool. The in-memory copy is rebuilt
 * on every poll.
 *
 * Even after approval, this phase never submits the order anywhere. The
 * decision is logged and emitted to the bus only.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import type {
  ShadowOrder, ApprovalRequest, ApprovalStatus,
} from './types'

const POLL_INTERVAL_MS = 2_000
const DEFAULT_EXPIRY_MS = 30_000

export class ApprovalQueue {
  private readonly path: string
  private requests = new Map<string, ApprovalRequest>()
  private pollTimer: NodeJS.Timeout | null = null

  private approvedCount = 0
  private rejectedCount = 0

  constructor(
    private readonly outputDir: string,
    private readonly autoApprove: boolean,    // for headless testing only
  ) {
    this.path = join(outputDir, 'pending.jsonl')
  }

  start(): void {
    mkdirSync(this.outputDir, { recursive: true })
    if (!existsSync(this.path)) writeFileSync(this.path, '')
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
    log.info(`[ApprovalQueue] watching ${this.path} (auto-approve=${this.autoApprove})`)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
  }

  /** Enqueue a new shadow order. */
  enqueue(order: ShadowOrder, autoReject?: string | null): ApprovalRequest {
    const status: ApprovalStatus = autoReject ? 'rejected' : 'pending'
    const req: ApprovalRequest = {
      id:           order.id,
      status,
      createdAtMs:  Date.now(),
      expiresAtMs:  Date.now() + DEFAULT_EXPIRY_MS,
      decidedAtMs:  status === 'rejected' ? Date.now() : null,
      decidedBy:    status === 'rejected' ? 'sandbox' : null,
      reason:       autoReject ?? null,
      order,
    }
    this.requests.set(req.id, req)
    this.persist()

    if (status === 'pending') {
      bus.emit('shadow.approvalRequest', {
        id:          req.id,
        simOrderId:  order.simOrderId,
        notionalUsd: order.notionalUsd,
        expiresAtMs: req.expiresAtMs,
      })
      if (this.autoApprove) {
        // Headless mode — auto-approve immediately (logs visible)
        this.decide(req.id, true, 'auto-approve', 'headless auto-approve enabled')
      }
    } else {
      this.rejectedCount++
      bus.emit('shadow.approvalDecision', {
        id:       req.id,
        approved: false,
        operator: 'sandbox',
        reason:   autoReject ?? 'rejected',
      })
    }
    return req
  }

  /** Operator decision — also callable programmatically by tests. */
  decide(id: string, approve: boolean, operator: string, reason: string): boolean {
    const req = this.requests.get(id)
    if (!req || req.status !== 'pending') return false
    req.status      = approve ? 'approved' : 'rejected'
    req.decidedAtMs = Date.now()
    req.decidedBy   = operator
    req.reason      = reason
    if (approve) this.approvedCount++
    else         this.rejectedCount++
    this.persist()
    bus.emit('shadow.approvalDecision', { id, approved: approve, operator, reason })
    log.info(`[ApprovalQueue] ${approve ? 'APPROVED' : 'REJECTED'} ${id} by ${operator}: ${reason}`)
    return true
  }

  getPending():  ApprovalRequest[] { return this.filter('pending') }
  getApproved(): ApprovalRequest[] { return this.filter('approved') }
  getRejected(): ApprovalRequest[] { return this.filter('rejected') }
  getCount(status: ApprovalStatus): number { return this.filter(status).length }

  // ── Internal ────────────────────────────────────────────────────────────────

  private filter(s: ApprovalStatus): ApprovalRequest[] {
    return [...this.requests.values()].filter(r => r.status === s)
  }

  private poll(): void {
    const now = Date.now()

    // Auto-expire pending past expiry
    for (const req of this.requests.values()) {
      if (req.status === 'pending' && now > req.expiresAtMs) {
        req.status = 'expired'
        req.decidedAtMs = now
        req.reason = 'expired'
        bus.emit('shadow.approvalDecision', {
          id: req.id, approved: false, operator: 'system', reason: 'expired',
        })
      }
    }

    // Re-read file to pick up manual approvals
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(l => l.length > 0)
      for (const line of lines) {
        const onDisk = JSON.parse(line) as ApprovalRequest
        const cur = this.requests.get(onDisk.id)
        if (!cur) continue
        if (cur.status === 'pending' && (onDisk.status === 'approved' || onDisk.status === 'rejected')) {
          // Operator edited the file → adopt the decision
          this.decide(onDisk.id, onDisk.status === 'approved',
            onDisk.decidedBy ?? 'operator',
            onDisk.reason ?? 'manual')
        }
      }
    } catch (err) {
      log.warn(`[ApprovalQueue] poll failed: ${(err as Error).message}`)
    }

    this.persist()
  }

  private persist(): void {
    const lines: string[] = []
    for (const req of this.requests.values()) lines.push(JSON.stringify(req))
    try { writeFileSync(this.path, lines.join('\n') + (lines.length > 0 ? '\n' : '')) }
    catch (err) { log.error(`[ApprovalQueue] persist failed: ${(err as Error).message}`) }
  }
}
