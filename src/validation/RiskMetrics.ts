/**
 * Risk analytics — pure functions on equity / return series.
 *
 * All metrics are deterministic. Annualization factor is supplied per call
 * since the underlying periodicity depends on the simulation context
 * (5-min markets × N markets per day).
 */
import type { RiskMetrics } from './types.js'

// Default annualization for 5-min Polymarket markets:
//   periods per day = 24h × 60min / 5min = 288 per market per day
//   × 252 trading days ≈ 72_576 periods/year
// We default to a conservative 5_000 → roughly 1 market-week of windows.
const DEFAULT_ANNUALIZATION = 5_000

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function stdDev(xs: number[], mu?: number): number {
  if (xs.length < 2) return 0
  const m = mu ?? mean(xs)
  let v = 0
  for (const x of xs) v += (x - m) ** 2
  return Math.sqrt(v / xs.length)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))
  return sorted[idx]!
}

export function maxDrawdown(equity: readonly number[]): number {
  let peak = -Infinity
  let maxDd = 0
  for (const v of equity) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = (peak - v) / peak
      if (dd > maxDd) maxDd = dd
    }
  }
  return maxDd
}

export function ulcerIndex(equity: readonly number[]): number {
  if (equity.length === 0) return 0
  let peak = -Infinity
  let sqSum = 0
  for (const v of equity) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = (peak - v) / peak
      sqSum += dd * dd
    }
  }
  return Math.sqrt(sqSum / equity.length)
}

export function sharpe(returns: readonly number[], annualization = DEFAULT_ANNUALIZATION): number {
  if (returns.length < 2) return 0
  const r = [...returns]
  const m = mean(r)
  const s = stdDev(r, m)
  return s > 0 ? (m / s) * Math.sqrt(annualization) : 0
}

export function sortino(returns: readonly number[], annualization = DEFAULT_ANNUALIZATION): number {
  if (returns.length < 2) return 0
  const r = [...returns]
  const m = mean(r)
  const negatives = r.filter(x => x < 0)
  const dStd = stdDev(negatives, 0)
  return dStd > 0 ? (m / dStd) * Math.sqrt(annualization) : 0
}

export function consecutiveLossDistribution(returns: readonly number[]): Record<number, number> {
  const dist: Record<number, number> = {}
  let streak = 0
  for (const r of returns) {
    if (r < 0) {
      streak++
    } else if (streak > 0) {
      dist[streak] = (dist[streak] ?? 0) + 1
      streak = 0
    }
  }
  if (streak > 0) dist[streak] = (dist[streak] ?? 0) + 1
  return dist
}

// Compute all metrics from an equity curve (and per-period returns derived from it).
export function computeRiskMetrics(
  equityCurve: readonly number[],
  annualization = DEFAULT_ANNUALIZATION,
): RiskMetrics {
  if (equityCurve.length < 2) {
    return {
      count: equityCurve.length, totalReturn: 0,
      sharpe: 0, sortino: 0, maxDrawdown: 0, ulcerIndex: 0,
      calmar: 0, var5pct: 0, consecutiveLossDistribution: {},
    }
  }
  // Period returns from successive equity values
  const returns: number[] = []
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!
    if (prev > 0) returns.push((equityCurve[i]! - prev) / prev)
  }

  const start  = equityCurve[0]!
  const end    = equityCurve[equityCurve.length - 1]!
  const totRet = start > 0 ? (end - start) / start : 0
  const maxDd  = maxDrawdown(equityCurve)
  const sorted = [...returns].sort((a, b) => a - b)

  return {
    count:       returns.length,
    totalReturn: totRet,
    sharpe:      sharpe(returns, annualization),
    sortino:     sortino(returns, annualization),
    maxDrawdown: maxDd,
    ulcerIndex:  ulcerIndex(equityCurve),
    calmar:      maxDd > 0 ? (totRet / maxDd) : 0,
    var5pct:     percentile(sorted, 0.05),
    consecutiveLossDistribution: consecutiveLossDistribution(returns),
  }
}
