/**
 * Drift evolution analyzer — tracks how drift metrics change over hours/days
 * and detects structural breaks via CUSUM.
 *
 * Subscribes to `drift.alert` events (emitted by Phase 6 DriftDetector) and
 * builds per-metric histories. Also tracks regime transitions from
 * signal.frame events.
 *
 * Emits `ops.structuralBreak` when a metric's CUSUM exceeds threshold.
 */
import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { RingBuffer } from '../utils/RingBuffer'
import type {
  DriftEvolutionPoint, DriftEvolutionReport, StructuralBreakEvent,
} from './types'

const POINTS_PER_METRIC = 720      // 12h at one per minute (drift.alert is throttled to 60s/metric)
const TRANSITION_BUFFER = 200
const ALERT_COOLDOWN_MS = 10 * 60_000

interface PerMetricState {
  points: RingBuffer<DriftEvolutionPoint>
  cusum:  number
  lastAlertMs: number
  // Running mean / std for CUSUM (Welford)
  count: number
  mean:  number
  m2:    number
}

export class DriftEvolutionAnalyzer {
  private readonly perMetric = new Map<string, PerMetricState>()
  private readonly transitions = new RingBuffer<{ ts: number; symbol: string; from: string; to: string }>(TRANSITION_BUFFER)
  private readonly structuralBreaks: StructuralBreakEvent[] = []
  private readonly lastRegimeBySymbol = new Map<string, string>()

  private started = false

  constructor(
    private readonly cusumK: number,   // allowance (std-devs)
    private readonly cusumH: number,   // threshold (std-devs accumulated)
  ) {}

  start(): void {
    if (this.started) return
    this.started = true

    bus.on('drift.alert', (e) => {
      const point: DriftEvolutionPoint = {
        ts: Date.now(), metric: e.metric, drift: e.drift, severity: e.severity,
      }
      const state = this.getOrCreate(e.metric)
      state.points.push(point)
      this.updateCusum(state, e.metric, e.drift)
    })

    bus.on('signal.frame', ({ frame }) => {
      const prev = this.lastRegimeBySymbol.get(frame.symbol)
      if (prev && prev !== frame.regime) {
        this.transitions.push({ ts: Date.now(), symbol: frame.symbol, from: prev, to: frame.regime })
      }
      this.lastRegimeBySymbol.set(frame.symbol, frame.regime)
    })

    log.info('[DriftEvolution] started', { cusumK: this.cusumK, cusumH: this.cusumH })
  }

  getReport(): DriftEvolutionReport {
    const now = Date.now()
    const points: DriftEvolutionPoint[] = []
    const ratesPerHour: Record<string, number> = {}

    for (const [metric, st] of this.perMetric) {
      const arr = st.points.toArray()
      const oneHourAgo = now - 3_600_000
      const lastHour = arr.filter(p => p.ts >= oneHourAgo).length
      ratesPerHour[metric] = lastHour
      // Take last 30 points across all metrics
      for (const p of arr.slice(-30)) points.push(p)
    }

    points.sort((a, b) => a.ts - b.ts)

    return {
      generatedAtMs:        now,
      recentDriftPoints:    points.slice(-100),
      driftRatePerHour:     ratesPerHour,
      structuralBreaks:     [...this.structuralBreaks].slice(-50),
      regimeTransitions:    this.transitions.toArray(),
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private getOrCreate(metric: string): PerMetricState {
    let st = this.perMetric.get(metric)
    if (!st) {
      st = {
        points: new RingBuffer<DriftEvolutionPoint>(POINTS_PER_METRIC),
        cusum:  0, lastAlertMs: 0, count: 0, mean: 0, m2: 0,
      }
      this.perMetric.set(metric, st)
    }
    return st
  }

  private updateCusum(state: PerMetricState, metric: string, drift: number): void {
    // Welford running mean + variance to normalize the next observation
    state.count++
    const delta = drift - state.mean
    state.mean += delta / state.count
    const delta2 = drift - state.mean
    state.m2 += delta * delta2

    if (state.count < 10) return    // warm-up

    const variance = state.m2 / (state.count - 1)
    const std = Math.sqrt(variance) || 1e-9
    const z = (drift - state.mean) / std

    // One-sided CUSUM on |z|
    state.cusum = Math.max(0, state.cusum + (Math.abs(z) - this.cusumK))

    if (state.cusum > this.cusumH) {
      const now = Date.now()
      if (now - state.lastAlertMs > ALERT_COOLDOWN_MS) {
        state.lastAlertMs = now
        const ev: StructuralBreakEvent = {
          ts:        now,
          metric,
          cusum:     state.cusum,
          threshold: this.cusumH,
          reason:    `CUSUM ${state.cusum.toFixed(1)} > ${this.cusumH} on ${metric}`,
        }
        this.structuralBreaks.push(ev)
        while (this.structuralBreaks.length > 200) this.structuralBreaks.shift()
        bus.emit('ops.structuralBreak', { metric, cusum: state.cusum, threshold: this.cusumH })
        log.warn(`[DriftEvolution] structural break on ${metric}: CUSUM=${state.cusum.toFixed(1)}`)
        // Reset CUSUM after detection so it can re-trigger on a new shift
        state.cusum = 0
      }
    }
  }
}
