import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import type { SignalFrame, MarketRegime, SignalObservabilityMetrics } from '../signals/types.js'
import type { MarketSymbol } from '../types/market.js'

const HIGH_CONFIDENCE_THRESHOLD = 0.6

export class SignalObserver {
  private frames           = 0
  private latenciesUs:     number[] = []
  private highConfidence   = 0
  private directionFlips   = 0
  private regimeTransitions = 0
  private startMs          = Date.now()

  private lastFrame: Partial<Record<MarketSymbol, SignalFrame>>  = {}
  private lastRegime: Partial<Record<MarketSymbol, MarketRegime>> = {}

  start(): void {
    bus.on('signal.frame', ({ frame, latencyUs }) => {
      this.observe(frame, latencyUs)
    })
    log.info('[SignalObserver] started')
  }

  private observe(frame: SignalFrame, latencyUs: number): void {
    this.frames++
    this.latenciesUs.push(latencyUs)

    if (frame.composite.confidence > HIGH_CONFIDENCE_THRESHOLD) this.highConfidence++

    const sym  = frame.symbol
    const prev = this.lastFrame[sym]
    if (prev) {
      if (prev.composite.direction !== frame.composite.direction) this.directionFlips++
      if (prev.regime !== frame.regime)                           this.regimeTransitions++
    }
    this.lastFrame[sym]  = frame
    this.lastRegime[sym] = frame.regime
  }

  getMetrics(): SignalObservabilityMetrics {
    const elapsedSec  = Math.max((Date.now() - this.startMs) / 1000, 1)
    const lats        = this.latenciesUs
    const avgLatency  = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0

    // p99 latency
    let p99Latency = 0
    if (lats.length >= 100) {
      const sorted = [...lats].sort((a, b) => a - b)
      p99Latency = sorted[Math.floor(sorted.length * 0.99)]!
    }

    return {
      framesComputed:      this.frames,
      framesPerSec:        this.frames / elapsedSec,
      avgComputeLatencyUs: avgLatency,
      p99ComputeLatencyUs: p99Latency,
      directionFlips:      this.directionFlips,
      regimeTransitions:   this.regimeTransitions,
      highConfidenceRate:  this.frames > 0 ? this.highConfidence / this.frames : 0,
    }
  }
}
