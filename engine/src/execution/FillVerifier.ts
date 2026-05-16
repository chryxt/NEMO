/**
 * Fill verifier — after order submission, polls the Polymarket REST API
 * for the realized fill and produces an ExecutionDelta vs the shadow
 * prediction.
 *
 * Polls are scheduled — never tight-looping. Polls stop after a fill is
 * observed, the order expires, or maxAttempts is reached.
 */
import { log } from '../utils/logger'
import { RingBuffer } from '../utils/RingBuffer'
import type { PolymarketClient } from './PolymarketClient'
import type { ExecutionDelta, ExecutionOrder } from './types'
import type { ShadowOrder } from '../shadow/types'

const POLL_INTERVAL_MS = 5_000
const MAX_ATTEMPTS     = 12         // 1 minute total polling
const RECENT_DELTAS    = 20

export class FillVerifier {
  private readonly deltas = new RingBuffer<ExecutionDelta>(RECENT_DELTAS)
  private readonly inflight = new Map<string, NodeJS.Timeout>()
  private readonly attempts = new Map<string, number>()

  constructor(
    private readonly client: PolymarketClient,
    private readonly onDelta: (d: ExecutionDelta) => void,
  ) {}

  begin(execOrder: ExecutionOrder, shadow: ShadowOrder): void {
    if (!execOrder.remoteOrderId) return
    this.attempts.set(execOrder.id, 0)
    const tick = async () => {
      const tries = (this.attempts.get(execOrder.id) ?? 0) + 1
      this.attempts.set(execOrder.id, tries)

      const remote = await this.client.getOrder(execOrder.remoteOrderId!)
      if (remote && (remote.status === 'filled' || remote.filled >= remote.size)) {
        this.finalize(execOrder, shadow, remote.price, remote.fee, Date.now())
        return
      }

      if (tries >= MAX_ATTEMPTS) {
        log.warn(`[FillVerifier] gave up polling ${execOrder.remoteOrderId} after ${tries} attempts`)
        this.cleanup(execOrder.id)
        // emit null-realized delta so the caller can see expiry
        const delta: ExecutionDelta = {
          executionOrderId:    execOrder.id,
          generatedAtMs:       Date.now(),
          predictedPrice:      shadow.predictedFill.price,
          realizedPrice:       null,
          priceDeltaBps:       null,
          predictedFeeUsd:     shadow.feePreviewUsd,
          realizedFeeUsd:      null,
          feeDeltaUsd:         null,
          predictedSlippageBps:shadow.predictedFill.slippageBps,
          realizedSlippageBps: null,
          slippageDeltaBps:    null,
          latencyMs:           null,
        }
        this.deltas.push(delta)
        this.onDelta(delta)
        return
      }
      const t = setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
      this.inflight.set(execOrder.id, t)
    }
    void tick()
  }

  cancel(orderId: string): void {
    this.cleanup(orderId)
  }

  getRecent(): ExecutionDelta[] {
    return this.deltas.toArray()
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private finalize(execOrder: ExecutionOrder, shadow: ShadowOrder, price: number, feeUsd: number, ts: number): void {
    this.cleanup(execOrder.id)
    const priceDeltaBps = shadow.predictedFill.price > 0
      ? Math.abs(price - shadow.predictedFill.price) / shadow.predictedFill.price * 10_000
      : null
    const feeDelta = feeUsd - shadow.feePreviewUsd
    const realizedSlipBps = shadow.predictedFill.price > 0
      ? (price - shadow.predictedFill.price) / shadow.predictedFill.price * 10_000
      : null

    const delta: ExecutionDelta = {
      executionOrderId:    execOrder.id,
      generatedAtMs:       ts,
      predictedPrice:      shadow.predictedFill.price,
      realizedPrice:       price,
      priceDeltaBps,
      predictedFeeUsd:     shadow.feePreviewUsd,
      realizedFeeUsd:      feeUsd,
      feeDeltaUsd:         feeDelta,
      predictedSlippageBps:shadow.predictedFill.slippageBps,
      realizedSlippageBps: realizedSlipBps,
      slippageDeltaBps:    realizedSlipBps != null ? realizedSlipBps - shadow.predictedFill.slippageBps : null,
      latencyMs:           execOrder.submittedAtMs != null ? ts - execOrder.submittedAtMs : null,
    }
    this.deltas.push(delta)
    this.onDelta(delta)
  }

  private cleanup(id: string): void {
    const t = this.inflight.get(id)
    if (t) clearTimeout(t)
    this.inflight.delete(id)
    this.attempts.delete(id)
  }
}
