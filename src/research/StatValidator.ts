/**
 * Statistical validation engine for signal research.
 *
 * Methodology:
 * - For each signal frame, find the oracle price N seconds later (forward return)
 * - Compute hit rate, average return, Pearson correlation, and persistence
 * - Break down hit rate by market regime
 * - Only count frames where signal.confidence > MIN_CONFIDENCE
 */
import { pearson } from '../signals/math.js'
import type { SignalFrame, SignalStats, ForwardStats, MarketRegime } from '../signals/types.js'
import type { MarketSymbol } from '../types/market.js'

const HORIZONS_MS       = [5_000, 30_000, 60_000]  // forward-return horizons
const MIN_CONFIDENCE    = 0.3                        // ignore low-confidence signals
const DIRECTION_EPSILON = 0.0001                     // min return magnitude to count as hit

type SignalKey = 'orderflow' | 'momentum' | 'spread' | 'whale' | 'positioning' | 'composite'
const SIGNAL_KEYS: SignalKey[] = ['orderflow', 'momentum', 'spread', 'whale', 'positioning', 'composite']

export class StatValidator {
  validate(frames: SignalFrame[], symbol: MarketSymbol): SignalStats[] {
    const symFrames = frames.filter(f => f.symbol === symbol)
    if (symFrames.length < 10) return []

    // Build sorted oracle price lookup: ts (ms) → price
    // Uses the oracle price from each signal frame
    const priceAt = this.buildPriceLookup(symFrames)

    return SIGNAL_KEYS.map(key => this.computeStats(symFrames, key, priceAt))
  }

  private buildPriceLookup(frames: SignalFrame[]): (targetMs: number) => number | null {
    // frames are already time-ordered from the replay
    const entries = frames
      .map(f => ({ ts: f.ts, price: f.features.oracle.price }))
      .filter(e => e.price != null) as { ts: number; price: number }[]

    if (entries.length === 0) return () => null

    return (targetMs: number): number | null => {
      // Binary search for closest entry at or after targetMs
      let lo = 0, hi = entries.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (entries[mid]!.ts < targetMs) lo = mid + 1
        else hi = mid
      }
      // Allow up to 30s tolerance
      const closest = entries[lo]
      if (!closest || Math.abs(closest.ts - targetMs) > 30_000) return null
      return closest.price
    }
  }

  private computeStats(
    frames:    SignalFrame[],
    key:       SignalKey,
    priceAt:   (targetMs: number) => number | null,
  ): SignalStats {
    const qualifying = frames.filter(f => {
      const sig = key === 'composite' ? f.composite : f.signals[key as keyof typeof f.signals]
      return sig.confidence >= MIN_CONFIDENCE && sig.direction !== 'neutral'
    })

    // Persistence: P(direction[t] === direction[t-1])
    let sameDir = 0, dirTotal = 0
    for (let i = 1; i < frames.length; i++) {
      const f    = frames[i]!
      const fp   = frames[i - 1]!
      const cur  = key === 'composite' ? f.composite  : f.signals[key  as keyof typeof f.signals]
      const prev = key === 'composite' ? fp.composite : fp.signals[key as keyof typeof fp.signals]
      dirTotal++
      if (cur.direction === prev.direction) sameDir++
    }
    const persistence = dirTotal > 0 ? sameDir / dirTotal : 0

    // Horizon stats
    const horizons: ForwardStats[] = HORIZONS_MS.map(horizonMs => {
      const sigValues: number[] = []
      const returns:   number[] = []
      let hits = 0, misses = 0

      for (const frame of qualifying) {
        const currentPrice = frame.features.oracle.price
        if (!currentPrice) continue

        const futurePrice = priceAt(frame.ts + horizonMs)
        if (!futurePrice) continue

        const ret = (futurePrice - currentPrice) / currentPrice
        const sig = key === 'composite' ? frame.composite : frame.signals[key as keyof typeof frame.signals]

        sigValues.push(sig.value)
        returns.push(ret)

        if (Math.abs(ret) < DIRECTION_EPSILON) continue
        const isHit = (sig.direction === 'up' && ret > 0) || (sig.direction === 'down' && ret < 0)
        if (isHit) hits++; else misses++
      }

      const sampleN  = hits + misses
      const hitRate  = sampleN > 0 ? hits / sampleN : 0
      const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0
      const corr      = pearson(sigValues, returns)

      return { horizon: horizonMs, hitRate, avgReturn, pearson: corr, sampleN }
    })

    // False positive rate: high-confidence signals (>0.7) that go the wrong way at 30s
    const highConf = qualifying.filter(f => {
      const sig = key === 'composite' ? f.composite : f.signals[key as keyof typeof f.signals]
      return sig.confidence > 0.7
    })
    let falsePosCount = 0, falsePosTotal = 0
    for (const frame of highConf) {
      const currentPrice = frame.features.oracle.price
      if (!currentPrice) continue
      const futurePrice = priceAt(frame.ts + 30_000)
      if (!futurePrice) continue
      const ret = (futurePrice - currentPrice) / currentPrice
      if (Math.abs(ret) < DIRECTION_EPSILON) continue
      falsePosTotal++
      const sig = key === 'composite' ? frame.composite : frame.signals[key as keyof typeof frame.signals]
      const isWrong = (sig.direction === 'up' && ret < 0) || (sig.direction === 'down' && ret > 0)
      if (isWrong) falsePosCount++
    }
    const falsePositiveRate = falsePosTotal > 0 ? falsePosCount / falsePosTotal : 0

    // Regime breakdown: hitRate per regime at 30s horizon
    const regimes: Partial<Record<MarketRegime, number>> = {}
    const regimeCounts: Partial<Record<MarketRegime, { hits: number; total: number }>> = {}
    for (const frame of qualifying) {
      const currentPrice = frame.features.oracle.price
      if (!currentPrice) continue
      const futurePrice = priceAt(frame.ts + 30_000)
      if (!futurePrice) continue
      const ret = (futurePrice - currentPrice) / currentPrice
      if (Math.abs(ret) < DIRECTION_EPSILON) continue
      const r   = frame.regime
      const sig = key === 'composite' ? frame.composite : frame.signals[key as keyof typeof frame.signals]
      const hit = (sig.direction === 'up' && ret > 0) || (sig.direction === 'down' && ret < 0)
      if (!regimeCounts[r]) regimeCounts[r] = { hits: 0, total: 0 }
      regimeCounts[r]!.total++
      if (hit) regimeCounts[r]!.hits++
    }
    for (const [r, v] of Object.entries(regimeCounts) as [MarketRegime, { hits: number; total: number }][]) {
      regimes[r] = v.total > 0 ? v.hits / v.total : 0
    }

    return {
      signalName:      key,
      symbol:          qualifying[0]?.symbol ?? 'BTC' as MarketSymbol,
      sampleCount:     qualifying.length,
      persistence,
      falsePositiveRate,
      horizons,
      regimeBreakdown: regimes,
    }
  }
}
