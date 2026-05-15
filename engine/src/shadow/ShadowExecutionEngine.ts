/**
 * ShadowExecutionEngine — Phase 8 orchestrator for real-market readiness.
 *
 * Bundles together:
 *  - WalletAdapter           (address-only, default disabled)
 *  - EIP712Signer            (dry-run signatures only)
 *  - ShadowOrderEmitter      (Polymarket-shaped order structs from sim intents)
 *  - ExecutionComparator     (predicted vs realized fills)
 *  - ApprovalQueue           (file-backed JSONL, human-in-the-loop)
 *  - SandboxGuards           (max notional, halt file, single-strategy lock)
 *  - OperationalRiskMonitor  (signing / RPC / divergence flags)
 *  - ExecutionReadiness      (composite scoring)
 *  - AuditLog                (append-only hash-chained record)
 *
 * NO real submission. NO outbound network traffic. NO autonomous firing.
 */
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'
import { WalletAdapter } from './WalletAdapter.js'
import { EIP712Signer } from './EIP712Signer.js'
import { ShadowOrderEmitter } from './ShadowOrderEmitter.js'
import { ExecutionComparator } from './ExecutionComparator.js'
import { ApprovalQueue } from './ApprovalQueue.js'
import { SandboxGuards } from './SandboxGuards.js'
import { OperationalRiskMonitor } from './OperationalRisk.js'
import { ExecutionReadiness } from './ExecutionReadiness.js'
import { AuditLog } from './AuditLog.js'
import { RealExecutionGateway } from '../execution/RealExecutionGateway.js'
import type { SimulationEngine } from '../sim/SimulationEngine.js'
import type { ShadowSnapshot } from './types.js'

// Polymarket CTF Exchange address on Polygon (informational — used only for
// canonical EIP-712 domain hashing; this engine never connects to it).
const POLY_CHAIN_ID = 137
const POLY_VERIFYING_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'

export class ShadowExecutionEngine {
  private readonly wallet:     WalletAdapter
  private readonly signer:     EIP712Signer
  private readonly emitter:    ShadowOrderEmitter
  private readonly comparator: ExecutionComparator
  private readonly approval:   ApprovalQueue
  private readonly guards:     SandboxGuards
  private readonly risk:       OperationalRiskMonitor
  private readonly readiness:  ExecutionReadiness
  private readonly audit:      AuditLog
  private readonly gateway:    RealExecutionGateway | null

  private started   = false
  private fillsSeen = new Set<string>()

  constructor(private readonly sim: SimulationEngine) {
    this.wallet     = new WalletAdapter(
      config.shadowWalletEnabled,
      config.shadowWalletAddress,
      POLY_CHAIN_ID,
      config.shadowVerifyingContract || POLY_VERIFYING_CONTRACT,
    )
    this.signer     = new EIP712Signer(this.wallet)
    this.emitter    = new ShadowOrderEmitter(this.wallet, this.signer)
    this.comparator = new ExecutionComparator()
    this.approval   = new ApprovalQueue(config.shadowOutputDir, config.shadowAutoApprove)
    this.guards     = new SandboxGuards()
    this.risk       = new OperationalRiskMonitor()
    this.readiness  = new ExecutionReadiness(this.comparator, this.risk, this.emitter)
    this.audit      = new AuditLog(config.shadowOutputDir)
    this.gateway    = config.executionEnabled
      ? new RealExecutionGateway(sim, this.approval)
      : null

    log.info('[ShadowExecutionEngine] constructed', {
      walletEnabled:        config.shadowWalletEnabled,
      walletAddress:        this.wallet.getAddress(),
      verifyingContract:    this.wallet.getVerifyingContract(),
      maxNotionalUsd:       config.shadowMaxNotionalUsd,
      autoApprove:          config.shadowAutoApprove,
      gateway:              config.executionEnabled,
      realSubmission:       config.executionEnabled && config.executionArmed && !config.executionDryRun,
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.audit.start()
    this.approval.start()
    if (this.gateway) await this.gateway.start()
    this.guards.start((reason) => {
      this.audit.append('shadow.halt', { reason }, 'engine')
      if (!this.sim.isKillSwitchActive()) {
        this.sim.triggerKillSwitch(`shadow-halt: ${reason}`)
      }
    })
    this.emitter.onEmit((order) => {
      try {
        // Audit the creation + signature first
        this.audit.append('shadow.created', {
          id:           order.id,
          simOrderId:   order.simOrderId,
          symbol:       order.symbol,
          outcome:      order.outcome,
          side:         order.side,
          tokenId:      order.tokenId,
          size:         order.size,
          limitPrice:   order.limitPrice,
          notionalUsd:  order.notionalUsd,
        }, 'engine')
        this.audit.append('shadow.signed', {
          id:        order.id,
          signature: order.signature.value,
          hash:      order.signature.hash,
        }, 'engine')

        if (!this.signer.validateDryRun(order.signature)) {
          this.risk.recordFlag('signing-failure',
            `invalid dry-run signature on ${order.id}`)
          return
        }

        // Sandbox-guard rejection (auto-rejects)
        const rejectReason = this.guards.rejectReason(order)
        const req = this.approval.enqueue(order, rejectReason)
        this.comparator.observeShadow(order)

        // Phase 9: hand to gateway for pre-flight evaluation (no submission
        // until shadow approval decision arrives separately)
        if (this.gateway && !rejectReason) this.gateway.considerShadow(order)

        this.audit.append(rejectReason ? 'shadow.rejected' : 'shadow.queued', {
          id: req.id, reason: rejectReason ?? null,
        }, 'engine')
      } catch (err) {
        this.risk.recordFlag('signing-failure',
          `shadow handler error: ${(err as Error).message}`)
        log.error(`[ShadowExecutionEngine] handler error: ${(err as Error).message}`)
      }
    })
    this.emitter.start()
    this.comparator.start()
    this.risk.start()

    // Approval decisions → audit
    bus.on('shadow.approvalDecision', (e) => {
      this.audit.append('shadow.decision', e, e.operator)
    })

    // Realized fills → comparator (so we can score realism)
    bus.on('market.tick', () => this.pollFills())

    this.audit.append('shadow.session.start', {
      wallet:               this.wallet.getAddress(),
      chainId:              this.wallet.getChainId(),
      verifyingContract:    this.wallet.getVerifyingContract(),
      autoApprove:          config.shadowAutoApprove,
      maxNotionalUsd:       config.shadowMaxNotionalUsd,
      realSubmissionAllowed:false,
    }, 'engine')

    log.info('[ShadowExecutionEngine] started')
  }

  stop(): void {
    if (!this.started) return
    this.audit.append('shadow.session.stop', {
      ordersGenerated:  this.emitter.getOrdersGenerated(),
      ordersSigned:     this.emitter.getSignedCount(),
      approvalsApproved:this.approval.getCount('approved'),
      approvalsRejected:this.approval.getCount('rejected'),
    }, 'engine')
    if (this.gateway) this.gateway.stop()
    this.guards.stop()
    this.approval.stop()
    this.audit.stop()
    this.started = false
    log.info('[ShadowExecutionEngine] stopped')
  }

  snapshot(): ShadowSnapshot {
    return {
      enabled:           true,
      ordersGenerated:   this.emitter.getOrdersGenerated(),
      ordersSigned:      this.emitter.getSignedCount(),
      approvalsPending:  this.approval.getCount('pending'),
      approvalsApproved: this.approval.getCount('approved'),
      approvalsRejected: this.approval.getCount('rejected'),
      readiness:         this.readiness.getReport(),
      operationalRisk:   this.risk.getStatus(),
      sandbox:           this.guards.getStatus(),
      auditEntries:      this.audit.getEntryCount(),
      recent: {
        pending:     this.approval.getPending().slice(-3),
        approved:    this.approval.getApproved().slice(-3),
        comparisons: this.comparator.getRecent().slice(-5),
      },
      execution:   this.gateway?.snapshot() ?? null,
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private pollFills(): void {
    const fills = this.sim.getPortfolio().getFills()
    for (const f of fills) {
      const key = `${f.orderId}:${f.ts}:${f.side}`
      if (this.fillsSeen.has(key)) continue
      this.fillsSeen.add(key)
      this.comparator.observeRealizedFill(f.orderId, f.price, f.ts)
    }
  }
}
