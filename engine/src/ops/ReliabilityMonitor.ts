/**
 * Long-run reliability monitor — tracks websocket uptime, reconnect frequency,
 * event lag, processing latency, memory growth, and stale-feed incidents.
 *
 * All metrics are pure observation; no side effects on simulation state.
 */
import { statfsSync } from 'fs'
import { bus } from '../bus/EventBus.js'
import { RingBuffer } from '../utils/RingBuffer.js'
import type { ReliabilityReport, ReliabilitySample } from './types.js'

const SAMPLE_BUFFER       = 4_320     // ~36h at 30s samples
const LAG_BUFFER          = 1_000     // recent event lag samples
const RECONNECT_BUFFER    =   200

interface ConnectionEpisode { from: number; to: number | null; ok: boolean }

export class ReliabilityMonitor {
  private readonly samples       = new RingBuffer<ReliabilitySample>(SAMPLE_BUFFER)
  private readonly lagSamples    = new RingBuffer<number>(LAG_BUFFER)
  private readonly rtdsHistory:  ConnectionEpisode[] = []
  private readonly clobHistory:  ConnectionEpisode[] = []
  private readonly recentReconnects = new RingBuffer<{ ts: number; service: 'rtds'|'clob' }>(RECONNECT_BUFFER)

  private rtdsReconnects     = 0
  private clobReconnects     = 0
  private staleFeedIncidents = 0
  private degradedEpisodes   = 0
  private peakHeapMb         = 0

  private started = false
  private startedAtMs = 0
  private sampleTimer: NodeJS.Timeout | null = null

  start(intervalMs: number): void {
    if (this.started) return
    this.started = true
    this.startedAtMs = Date.now()

    bus.on('oracle.price', (e) => {
      const lag = Date.now() - e.ts
      this.lagSamples.push(lag)
    })

    bus.on('connection.change', (e) => {
      const now = Date.now()
      const history = e.service === 'rtds' ? this.rtdsHistory : this.clobHistory
      if (e.status === 'reconnecting' || e.status === 'dead') {
        const last = history[history.length - 1]
        if (last && last.to == null) last.to = now
        if (e.status === 'reconnecting') {
          if (e.service === 'rtds') this.rtdsReconnects++
          else                       this.clobReconnects++
          this.recentReconnects.push({ ts: now, service: e.service })
        }
      } else if (e.status === 'connected') {
        history.push({ from: now, to: null, ok: true })
      } else if (e.status === 'connecting') {
        history.push({ from: now, to: null, ok: false })
      }
    })

    bus.on('system.warning',  () => { this.staleFeedIncidents++ })
    bus.on('system.degraded', () => { this.degradedEpisodes++ })

    this.sampleTimer = setInterval(() => this.takeSample(), intervalMs)
    this.takeSample()
  }

  stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer)
    this.started = false
  }

  // Number of reconnects for a service inside the trailing window
  recentReconnectCount(service: 'rtds' | 'clob', windowMs: number): number {
    const cutoff = Date.now() - windowMs
    return this.recentReconnects.toArray().filter(r => r.ts >= cutoff && r.service === service).length
  }

  getReport(): ReliabilityReport {
    const samples = this.samples.toArray()
    const lags    = this.lagSamples.toArray()
    const now     = Date.now()

    const avgHeap = samples.length > 0
      ? samples.reduce((s, x) => s + x.heapMb, 0) / samples.length
      : 0

    const avgLag = lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : 0
    let p99Lag = 0
    if (lags.length >= 20) {
      const sorted = [...lags].sort((a, b) => a - b)
      p99Lag = sorted[Math.floor(sorted.length * 0.99)]!
    }

    const rtdsPct = computeUptimePct(this.rtdsHistory, this.startedAtMs, now)
    const clobPct = computeUptimePct(this.clobHistory, this.startedAtMs, now)

    // Memory growth: simple linear regression slope (MB per hour)
    let memGrowth = 0
    if (samples.length >= 10) {
      const xs = samples.map(s => (s.ts - this.startedAtMs) / 3_600_000)
      const ys = samples.map(s => s.heapMb)
      memGrowth = linearSlope(xs, ys)
    }

    return {
      generatedAtMs:         now,
      uptimeSecs:            Math.floor((now - this.startedAtMs) / 1_000),
      rtdsReconnects:        this.rtdsReconnects,
      clobReconnects:        this.clobReconnects,
      rtdsUptimePct:         rtdsPct,
      clobUptimePct:         clobPct,
      staleFeedIncidents:    this.staleFeedIncidents,
      degradedEpisodes:      this.degradedEpisodes,
      avgEventLagMs:         avgLag,
      p99EventLagMs:         p99Lag,
      avgHeapMb:             avgHeap,
      peakHeapMb:            this.peakHeapMb,
      memoryGrowthRatePerHr: memGrowth,
      diskFreeMb:            diskFreeMb(),
    }
  }

  private takeSample(): void {
    const mem = process.memoryUsage()
    const heapMb = mem.heapUsed / 1_048_576
    if (heapMb > this.peakHeapMb) this.peakHeapMb = heapMb
    const recentLag = this.lagSamples.last() ?? 0
    this.samples.push({
      ts:         Date.now(),
      heapMb,
      rssMb:      mem.rss / 1_048_576,
      eventLagMs: recentLag,
    })
  }
}

function computeUptimePct(history: ConnectionEpisode[], startMs: number, nowMs: number): number {
  if (history.length === 0) return 0
  const total = Math.max(1, nowMs - startMs)
  let connectedMs = 0
  for (const ep of history) {
    if (!ep.ok) continue
    const to = ep.to ?? nowMs
    if (to > ep.from) connectedMs += (to - ep.from)
  }
  return Math.min(1, connectedMs / total)
}

function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]!; sy += ys[i]!
    sxx += xs[i]! * xs[i]!
    sxy += xs[i]! * ys[i]!
  }
  const denom = n * sxx - sx * sx
  if (Math.abs(denom) < 1e-9) return 0
  return (n * sxy - sx * sy) / denom
}

function diskFreeMb(): number | null {
  try {
    const s = statfsSync('.')
    return Math.floor((s.bavail * s.bsize) / 1_048_576)
  } catch {
    return null
  }
}
