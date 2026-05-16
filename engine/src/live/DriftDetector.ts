/**
 * Drift detector — compares live realtime metrics against a baseline JSON
 * exported from a Phase 5 validation run.
 *
 * Tracked metrics (rolling 5 minutes):
 *   - avgSpread             from clob.bestBidAsk events
 *   - signalsPerMin         from signal.frame events
 *   - avgConfidence         from signal.frame composite
 *   - whalesPerHour         from whale.alert events
 *   - avgLatencyMs          (Date.now() - event.ts) over recent oracle.price
 *   - avgFillSlippageBps    observed via SimulationEngine fills
 *
 * Emits 'drift.alert' bus events when drift severity hits a threshold.
 * Pull-based snapshot via getReport().
 */
import { readFileSync, existsSync } from 'fs'
import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { RingBuffer } from '../utils/RingBuffer'
import type { LiveBaseline, DriftReport, DriftMetric } from './types'
import type { SimFill } from '../sim/types'

const ROLL_MS               = 5 * 60_000
const SPREAD_BUFFER         = 1_000
const SIGNAL_BUFFER         = 200
const WHALE_BUFFER          = 100
const LATENCY_BUFFER        = 500
const FILL_BUFFER           = 100
const ALERT_THROTTLE_MS     = 60_000   // re-alert at most once per minute per metric

export function loadBaseline(path: string): LiveBaseline | null {
  if (!existsSync(path)) {
    log.warn(`[DriftDetector] baseline file not found: ${path}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LiveBaseline
  } catch (err) {
    log.error(`[DriftDetector] failed to parse baseline: ${(err as Error).message}`)
    return null
  }
}

interface TsValue { ts: number; v: number }

export class DriftDetector {
  private spreads:   RingBuffer<TsValue>      = new RingBuffer(SPREAD_BUFFER)
  private signals:   RingBuffer<TsValue>      = new RingBuffer(SIGNAL_BUFFER)  // v = confidence
  private whales:    RingBuffer<number>       = new RingBuffer(WHALE_BUFFER)   // timestamps
  private latencies: RingBuffer<TsValue>      = new RingBuffer(LATENCY_BUFFER)
  private fills:     RingBuffer<TsValue>      = new RingBuffer(FILL_BUFFER)    // v = |slippageBps|

  private lastAlertMs = new Map<string, number>()

  constructor(private readonly baseline: LiveBaseline | null) {}

  start(): void {
    bus.on('clob.bestBidAsk', e => {
      this.spreads.push({ ts: Date.now(), v: e.ask - e.bid })
    })

    bus.on('signal.frame', ({ frame }) => {
      this.signals.push({ ts: Date.now(), v: frame.composite.confidence })
    })

    bus.on('whale.alert', () => {
      this.whales.push(Date.now())
    })

    bus.on('oracle.price', e => {
      const lag = Date.now() - e.ts
      this.latencies.push({ ts: Date.now(), v: lag })
    })
  }

  observeFill(fill: SimFill): void {
    this.fills.push({ ts: fill.ts, v: Math.abs(fill.slippageBps) })
  }

  getReport(): DriftReport {
    if (!this.baseline) {
      return { hasBaseline: false, baselineSource: null, metrics: [], criticalCount: 0 }
    }

    const now    = Date.now()
    const cutoff = now - ROLL_MS

    const recent = <T extends TsValue | number>(buf: RingBuffer<T>): T[] => {
      const arr = buf.toArray()
      return arr.filter(x => (typeof x === 'number' ? x : x.ts) >= cutoff)
    }

    const meanV = (xs: TsValue[]): number => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x.v, 0) / xs.length

    const metrics: DriftMetric[] = []

    const liveSpread = meanV(recent(this.spreads) as TsValue[])
    if (this.baseline.metrics.avgSpread != null && liveSpread > 0) {
      metrics.push(this.computeMetric('avgSpread', this.baseline.metrics.avgSpread, liveSpread))
    }

    const recentSignals = recent(this.signals) as TsValue[]
    const liveSignalsPerMin = recentSignals.length / 5  // 5-min window
    if (this.baseline.metrics.avgSignalsPerMin != null && liveSignalsPerMin > 0) {
      metrics.push(this.computeMetric('signalsPerMin', this.baseline.metrics.avgSignalsPerMin, liveSignalsPerMin))
    }

    if (recentSignals.length > 0 && this.baseline.metrics.avgConfidence != null) {
      const liveConf = meanV(recentSignals)
      metrics.push(this.computeMetric('avgConfidence', this.baseline.metrics.avgConfidence, liveConf))
    }

    const recentWhales = (recent(this.whales) as number[]).length
    if (this.baseline.metrics.avgWhalesPerHour != null) {
      const liveWhalesPerHour = recentWhales * (60 / 5)  // extrapolate 5-min count to hourly
      metrics.push(this.computeMetric('whalesPerHour', this.baseline.metrics.avgWhalesPerHour, liveWhalesPerHour))
    }

    const recentLat = recent(this.latencies) as TsValue[]
    if (recentLat.length > 0 && this.baseline.metrics.avgLatencyMs != null) {
      const liveLat = meanV(recentLat)
      metrics.push(this.computeMetric('latencyMs', this.baseline.metrics.avgLatencyMs, liveLat))
    }

    const recentFills = recent(this.fills) as TsValue[]
    if (recentFills.length >= 5 && this.baseline.metrics.avgFillSlippageBps != null) {
      const liveSlip = meanV(recentFills)
      metrics.push(this.computeMetric('fillSlippageBps', this.baseline.metrics.avgFillSlippageBps, liveSlip))
    }

    // Emit alerts (throttled)
    for (const m of metrics) {
      if (m.severity === 'info') continue
      const last = this.lastAlertMs.get(m.metric) ?? 0
      if (now - last < ALERT_THROTTLE_MS) continue
      this.lastAlertMs.set(m.metric, now)
      bus.emit('drift.alert', m)
    }

    return {
      hasBaseline:    true,
      baselineSource: this.baseline.source,
      metrics,
      criticalCount:  metrics.filter(m => m.severity === 'critical').length,
    }
  }

  private computeMetric(metric: string, baseline: number, current: number): DriftMetric {
    const base = Math.abs(baseline) < 1e-9 ? 1e-9 : baseline
    const drift = (current - baseline) / Math.abs(base)
    const abs = Math.abs(drift)
    const severity: DriftMetric['severity'] =
      abs > 0.5 ? 'critical'
      : abs > 0.2 ? 'warning'
      : 'info'
    return { metric, baseline, current, drift, severity }
  }
}
