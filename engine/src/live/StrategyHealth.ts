/**
 * Strategy health monitor — rolling metrics over live signal/fill streams.
 *
 * Pull-based: getMetrics() computes everything on demand from RingBuffers.
 * No bus events emitted — alerts are AlertManager's responsibility.
 */
import { bus } from '../bus/EventBus'
import { RingBuffer } from '../utils/RingBuffer'
import type { SignalFrame, MarketRegime } from '../signals/types'
import type { SimFill } from '../sim/types'
import type { StrategyHealthMetrics } from './types'

const SIGNAL_BUFFER_SIZE     = 200
const FILL_BUFFER_SIZE       = 100
const LATENCY_BUFFER_SIZE    = 200
const REGIME_BUFFER_SIZE     =  50
const ROLLING_WINDOW_MS      = 5 * 60_000   // 5 min

interface SignalRecord { ts: number; symbol: string; confidence: number; direction: string; regime: MarketRegime }
interface FillRecord   { ts: number; slippageBps: number }

export class StrategyHealthMonitor {
  private signals:    RingBuffer<SignalRecord> = new RingBuffer(SIGNAL_BUFFER_SIZE)
  private fills:      RingBuffer<FillRecord>   = new RingBuffer(FILL_BUFFER_SIZE)
  private latencies:  RingBuffer<number>       = new RingBuffer(LATENCY_BUFFER_SIZE)
  private regimes:    RingBuffer<{ ts: number; regime: MarketRegime; symbol: string }> = new RingBuffer(REGIME_BUFFER_SIZE)

  private totalSignals = 0
  private lastSignalMs = 0

  start(): void {
    bus.on('signal.frame', ({ frame, latencyUs }) => {
      const now = Date.now()
      this.totalSignals++
      this.lastSignalMs = now
      this.signals.push({
        ts:         now,
        symbol:     frame.symbol,
        confidence: frame.composite.confidence,
        direction:  frame.composite.direction,
        regime:     frame.regime,
      })
      this.latencies.push(latencyUs)
      // Detect regime transition per symbol
      const lastSameSymbol = this.findLastSameSymbol(frame.symbol)
      if (!lastSameSymbol || lastSameSymbol.regime !== frame.regime) {
        this.regimes.push({ ts: now, regime: frame.regime, symbol: frame.symbol })
      }
    })
  }

  observeFill(fill: SimFill): void {
    this.fills.push({ ts: fill.ts, slippageBps: Math.abs(fill.slippageBps) })
  }

  getMetrics(): StrategyHealthMetrics {
    const now = Date.now()
    const cutoff = now - ROLLING_WINDOW_MS

    const signalsArr  = this.signals.toArray()
    const latArr      = this.latencies.toArray()
    const fillsArr    = this.fills.toArray()
    const regimeArr   = this.regimes.toArray()

    const recentSignals = signalsArr.filter(s => s.ts >= cutoff)
    const signalsPerMin = recentSignals.length / 5  // 5-min window

    const avgConfidence = recentSignals.length > 0
      ? recentSignals.reduce((s, x) => s + x.confidence, 0) / recentSignals.length
      : 0

    // Direction flips: per-symbol consecutive direction changes
    let directionFlips = 0
    const lastDirBySymbol = new Map<string, string>()
    for (const s of recentSignals) {
      const prev = lastDirBySymbol.get(s.symbol)
      if (prev && prev !== s.direction && s.direction !== 'neutral') directionFlips++
      lastDirBySymbol.set(s.symbol, s.direction)
    }

    const regimeTrans = regimeArr.filter(r => r.ts >= cutoff).length

    const regimeCounts: Partial<Record<MarketRegime, number>> = {}
    for (const s of recentSignals) {
      regimeCounts[s.regime] = (regimeCounts[s.regime] ?? 0) + 1
    }

    const avgLat = latArr.length > 0 ? latArr.reduce((a, b) => a + b, 0) / latArr.length : 0

    // p99 latency
    let p99 = 0
    if (latArr.length >= 20) {
      const sorted = [...latArr].sort((a, b) => a - b)
      p99 = sorted[Math.floor(sorted.length * 0.99)]!
    }

    const recentFills = fillsArr.filter(f => f.ts >= cutoff)
    const avgSlip = recentFills.length > 0
      ? recentFills.reduce((s, x) => s + x.slippageBps, 0) / recentFills.length
      : 0

    return {
      signalCount:               this.totalSignals,
      signalsLast5Min:           recentSignals.length,
      signalsPerMin,
      avgConfidence,
      avgComputeLatencyUs:       avgLat,
      p99ComputeLatencyUs:       p99,
      directionFlipsLast5Min:    directionFlips,
      regimeTransitionsLast5Min: regimeTrans,
      currentRegime:             regimeCounts,
      recentFillCount:           recentFills.length,
      avgFillSlippageBps:        avgSlip,
      lastSignalAgeMs:           this.lastSignalMs > 0 ? now - this.lastSignalMs : -1,
    }
  }

  private findLastSameSymbol(symbol: string): { regime: MarketRegime } | null {
    const arr = this.signals.toArray()
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]!.symbol === symbol) return { regime: arr[i]!.regime }
    }
    return null
  }
}
