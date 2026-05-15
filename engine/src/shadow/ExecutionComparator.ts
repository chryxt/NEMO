/**
 * Execution comparator — for each shadow order, observes the subsequent
 * CLOB book evolution and the realized SimulationEngine fill (when one
 * occurs) and produces a "realism score" telling us how closely the shadow
 * prediction matched ground truth.
 *
 * Pure observation. Does not modify simulation state.
 */
import { bus } from '../bus/EventBus.js'
import { RingBuffer } from '../utils/RingBuffer.js'
import type { ShadowOrder, ExecutionComparison } from './types.js'

const RECENT_COMPARISONS = 100
const WAIT_FOR_REALIZATION_MS = 5_000

interface PendingShadow {
  order:        ShadowOrder
  observedAt:   number
  midAfter:     number | null
  bestAfter:    number | null
  realizedFillTs: number | null
  realizedFillPrice: number | null
  startMid:     number | null
}

export class ExecutionComparator {
  private readonly pending  = new Map<string, PendingShadow>()
  private readonly comparisons = new RingBuffer<ExecutionComparison>(RECENT_COMPARISONS)
  private readonly midByToken = new Map<string, number>()
  private readonly bestByToken = new Map<string, { bid: number; ask: number }>()

  start(): void {
    bus.on('clob.bestBidAsk', (e) => {
      const mid = (e.bid + e.ask) / 2
      this.midByToken.set(e.tokenId, mid)
      this.bestByToken.set(e.tokenId, { bid: e.bid, ask: e.ask })
    })

    // Periodically finalize pending comparisons that have waited long enough
    bus.on('market.tick', () => this.finalizeMatured())
  }

  observeShadow(order: ShadowOrder): void {
    this.pending.set(order.id, {
      order,
      observedAt:        Date.now(),
      midAfter:          null,
      bestAfter:         null,
      realizedFillTs:    null,
      realizedFillPrice: null,
      startMid:          this.midByToken.get(order.tokenId) ?? null,
    })
  }

  observeRealizedFill(simOrderId: string, fillPrice: number, fillTs: number): void {
    for (const pending of this.pending.values()) {
      if (pending.order.simOrderId === simOrderId && pending.realizedFillTs == null) {
        pending.realizedFillTs    = fillTs
        pending.realizedFillPrice = fillPrice
      }
    }
  }

  getRecent(): ExecutionComparison[] {
    return this.comparisons.toArray()
  }

  // Mean realism score over recent comparisons
  meanRealismScore(): number {
    const arr = this.comparisons.toArray()
    if (arr.length === 0) return 0
    return arr.reduce((s, c) => s + c.realismScore, 0) / arr.length
  }

  realismStd(): number {
    const arr = this.comparisons.toArray()
    if (arr.length < 2) return 0
    const m = this.meanRealismScore()
    return Math.sqrt(arr.reduce((s, c) => s + (c.realismScore - m) ** 2, 0) / arr.length)
  }

  avgShadowToFillLatency(): { mean: number; std: number } {
    const arr = this.comparisons.toArray()
      .map(c => c.shadowToFillLatencyMs)
      .filter((x): x is number => x != null)
    if (arr.length === 0) return { mean: 0, std: 0 }
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length
    const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length
    return { mean, std: Math.sqrt(variance) }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private finalizeMatured(): void {
    const now = Date.now()
    for (const [id, p] of this.pending) {
      if (now - p.observedAt < WAIT_FOR_REALIZATION_MS) continue
      const post = this.midByToken.get(p.order.tokenId) ?? null
      const best = this.bestByToken.get(p.order.tokenId) ?? null
      const observedBest = best ? (p.order.side === 'BUY' ? best.ask : best.bid) : null

      const predicted = p.order.predictedFill.price
      const realized  = p.realizedFillPrice ?? observedBest ?? post

      const priceErrorBps = (realized != null && predicted > 0)
        ? Math.abs(realized - predicted) / predicted * 10_000
        : null

      const realismScore = priceErrorBps != null
        ? Math.max(0, 1 - priceErrorBps / 200)   // 0 bps = 1.0, 200 bps = 0.0
        : 0.5                                     // no data → neutral

      const shadowToFillLatencyMs = p.realizedFillTs != null
        ? p.realizedFillTs - p.order.createdAtMs
        : null

      const comp: ExecutionComparison = {
        shadowOrderId:      p.order.id,
        generatedAtMs:      now,
        predictedPrice:     predicted,
        observedMidAfter:   post,
        observedBestAfter:  observedBest,
        priceErrorBps,
        realismScore,
        shadowToFillLatencyMs,
      }
      this.comparisons.push(comp)
      this.pending.delete(id)
    }
  }
}
