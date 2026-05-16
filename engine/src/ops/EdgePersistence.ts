/**
 * Edge persistence tracker — rolling Sharpe, hit-rate, PnL stability,
 * confidence decay, edge half-life. Day-bucketed for day-over-day comparison.
 *
 * Read-only: pulls portfolio snapshot at sample cadence; subscribes to
 * signal.frame for confidence decay. Does not modify simulation state.
 */
import { bus } from '../bus/EventBus'
import { RingBuffer } from '../utils/RingBuffer'
import type { SimulationEngine } from '../sim/SimulationEngine'
import type {
  EdgePersistenceReport, EdgeWindow, DailyEdgeBucket,
} from './types'

const EQUITY_BUFFER       = 1_500          // 1500 × 60s = 25h
const CONFIDENCE_BUFFER   = 5_000
const DAILY_HISTORY_KEEP  = 30             // last 30 days
const PERIODS_PER_YEAR    = 525_600        // minutes/year for annualization

interface EquitySample { ts: number; equity: number; closedTrades: number; winners: number }
interface ConfSample   { ts: number; conf: number }

export class EdgePersistenceTracker {
  private readonly equity     = new RingBuffer<EquitySample>(EQUITY_BUFFER)
  private readonly confidence = new RingBuffer<ConfSample>(CONFIDENCE_BUFFER)
  private readonly dailyHistory: DailyEdgeBucket[] = []

  private startEquity = 0
  private startedAtMs = 0
  private dayDriftAlertCount = 0
  private dayStartEquity = 0
  private dayStartClosedTrades = 0
  private dayStartWinners = 0
  private daySignalCount = 0
  private currentDateUtc = ''
  private sampleTimer: NodeJS.Timeout | null = null

  constructor(private readonly sim: SimulationEngine) {}

  start(sampleMs: number): void {
    this.startedAtMs = Date.now()
    const snap = this.sim.getPortfolio().snapshot(this.sim.isKillSwitchActive())
    this.startEquity        = snap.totalEquity
    this.dayStartEquity     = snap.totalEquity
    this.dayStartClosedTrades = snap.closedTrades
    this.dayStartWinners      = snap.winners
    this.currentDateUtc       = dateUtc(Date.now())

    bus.on('signal.frame', ({ frame }) => {
      this.confidence.push({ ts: Date.now(), conf: frame.composite.confidence })
      this.daySignalCount++
    })

    bus.on('drift.alert', () => { this.dayDriftAlertCount++ })

    this.sampleTimer = setInterval(() => this.takeSample(), sampleMs)
    this.takeSample()
  }

  stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer)
  }

  // ── Called by OperationsEngine at UTC midnight ──────────────────────────────
  rolloverDay(): DailyEdgeBucket {
    const snap = this.sim.getPortfolio().snapshot(this.sim.isKillSwitchActive())
    const closedToday = snap.closedTrades - this.dayStartClosedTrades
    const winnersToday = snap.winners - this.dayStartWinners
    const hitRate = closedToday > 0 ? winnersToday / closedToday : 0
    const netPnl = snap.totalEquity - this.dayStartEquity
    const sharpe = this.computeDailySharpeFromBuffer()

    const bucket: DailyEdgeBucket = {
      dateUtc:      this.currentDateUtc,
      startEquity:  this.dayStartEquity,
      endEquity:    snap.totalEquity,
      netPnlUsd:    netPnl,
      closedTrades: closedToday,
      winners:      winnersToday,
      hitRate,
      sharpe,
      signalCount:  this.daySignalCount,
      driftAlerts:  this.dayDriftAlertCount,
    }

    this.dailyHistory.push(bucket)
    while (this.dailyHistory.length > DAILY_HISTORY_KEEP) this.dailyHistory.shift()

    // Reset day counters
    this.dayStartEquity       = snap.totalEquity
    this.dayStartClosedTrades = snap.closedTrades
    this.dayStartWinners      = snap.winners
    this.daySignalCount       = 0
    this.dayDriftAlertCount   = 0
    this.currentDateUtc       = dateUtc(Date.now())

    return bucket
  }

  // ── Snapshot at any time ────────────────────────────────────────────────────
  getReport(): EdgePersistenceReport {
    const now = Date.now()
    const snap = this.sim.getPortfolio().snapshot(this.sim.isKillSwitchActive())

    return {
      generatedAtMs:           now,
      startEquity:             this.startEquity,
      currentEquity:           snap.totalEquity,
      shortWindow:             this.computeWindow(10),
      mediumWindow:            this.computeWindow(60),
      longWindow:              this.computeWindow(360),
      confidenceDecayPerHour:  this.computeConfidenceDecay(),
      edgeHalfLifeHours:       this.computeEdgeHalfLife(),
      dailyHistory:            [...this.dailyHistory],
    }
  }

  rollingSharpe(windowMin: number): number {
    return this.computeWindow(windowMin).rollingSharpe
  }

  signalRatePerMin(windowMin: number): number {
    const cutoff = Date.now() - windowMin * 60_000
    const recent = this.confidence.toArray().filter(c => c.ts >= cutoff)
    return recent.length / windowMin
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private takeSample(): void {
    const snap = this.sim.getPortfolio().snapshot(this.sim.isKillSwitchActive())
    this.equity.push({
      ts:           Date.now(),
      equity:       snap.totalEquity,
      closedTrades: snap.closedTrades,
      winners:      snap.winners,
    })
  }

  private computeWindow(windowMin: number): EdgeWindow {
    const cutoff = Date.now() - windowMin * 60_000
    const arr = this.equity.toArray().filter(s => s.ts >= cutoff)
    if (arr.length < 2) {
      return zeroWindow(windowMin)
    }

    // Per-sample return = (E_i - E_{i-1}) / E_{i-1}
    const rets: number[] = []
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]!.equity
      if (prev <= 0) continue
      rets.push((arr[i]!.equity - prev) / prev)
    }
    if (rets.length === 0) return zeroWindow(windowMin)

    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length
    const std = Math.sqrt(variance)

    // Samples are spaced ~1/sampleMs apart. For minute samples, annualize × √(525600/spanMin).
    // Approximation: spanMin = windowMin; periods/year ≈ PERIODS_PER_YEAR/windowMin × rets.length
    const minutesPerSample = windowMin / Math.max(1, rets.length)
    const annualization = Math.sqrt(PERIODS_PER_YEAR / Math.max(0.5, minutesPerSample))
    const sharpe = std > 1e-9 ? (mean / std) * annualization : 0

    const closedTrades = arr[arr.length - 1]!.closedTrades - arr[0]!.closedTrades
    const winners      = arr[arr.length - 1]!.winners - arr[0]!.winners
    const hitRate      = closedTrades > 0 ? winners / closedTrades : 0
    const netPnl       = arr[arr.length - 1]!.equity - arr[0]!.equity

    // PnL stability: 1 - normalized skew of returns (higher = more symmetric)
    const skew = computeSkew(rets, mean, std)
    const stability = std > 1e-9 ? 1 / (1 + Math.abs(skew)) : 1

    return {
      windowMin,
      samples:        rets.length,
      meanReturn:     mean,
      stdReturn:      std,
      rollingSharpe:  sharpe,
      rollingHitRate: hitRate,
      pnlStability:   stability,
      closedTrades,
      netPnlUsd:      netPnl,
    }
  }

  // Daily Sharpe = sharpe of equity samples within today's UTC date
  private computeDailySharpeFromBuffer(): number {
    const startOfDay = utcMidnight(this.currentDateUtc).getTime()
    const arr = this.equity.toArray().filter(s => s.ts >= startOfDay)
    if (arr.length < 2) return 0
    const rets: number[] = []
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]!.equity
      if (prev <= 0) continue
      rets.push((arr[i]!.equity - prev) / prev)
    }
    if (rets.length === 0) return 0
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length
    const std = Math.sqrt(variance)
    if (std < 1e-9) return 0
    // Annualize with minute-equivalent periodicity
    const minutesPerSample = (24 * 60) / Math.max(1, rets.length)
    return (mean / std) * Math.sqrt(PERIODS_PER_YEAR / Math.max(0.5, minutesPerSample))
  }

  // Confidence decay = linear regression slope of avg-confidence vs hours since start
  private computeConfidenceDecay(): number {
    const arr = this.confidence.toArray()
    if (arr.length < 30) return 0
    const xs = arr.map(c => (c.ts - this.startedAtMs) / 3_600_000)
    const ys = arr.map(c => c.conf)
    return linearSlope(xs, ys)
  }

  // Edge half-life: fit exp(-t/τ) on |rolling-Sharpe| samples taken hourly.
  // Returns τ in hours if there's a discernible decay (slope < 0 on log-data).
  private computeEdgeHalfLife(): number | null {
    if (this.dailyHistory.length < 3) return null
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < this.dailyHistory.length; i++) {
      const sharpe = Math.abs(this.dailyHistory[i]!.sharpe)
      if (sharpe < 1e-3) continue
      xs.push(i * 24)        // hours since first day
      ys.push(Math.log(sharpe))
    }
    if (xs.length < 3) return null
    const slope = linearSlope(xs, ys)
    if (slope >= -1e-6) return null      // not decaying
    return Math.log(2) / -slope
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function zeroWindow(windowMin: number): EdgeWindow {
  return {
    windowMin,
    samples:        0,
    meanReturn:     0,
    stdReturn:      0,
    rollingSharpe:  0,
    rollingHitRate: 0,
    pnlStability:   0,
    closedTrades:   0,
    netPnlUsd:      0,
  }
}

function computeSkew(xs: number[], mean: number, std: number): number {
  if (xs.length < 3 || std < 1e-9) return 0
  let s = 0
  for (const x of xs) s += Math.pow((x - mean) / std, 3)
  return s / xs.length
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

function dateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function utcMidnight(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`)
}
