// Pure math utilities for signal computation. No side effects.

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function variance(values: number[], mu?: number): number {
  if (values.length < 2) return 0
  const m = mu ?? mean(values)
  return values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length
}

export function stdDev(values: number[], mu?: number): number {
  return Math.sqrt(variance(values, mu))
}

// Ordinary-least-squares slope of (index, value) pairs
export function linearSlope(values: number[]): number {
  const n = values.length
  if (n < 2) return 0
  const xs = values.map((_, i) => i)
  const mx = mean(xs)
  const my = mean(values)
  const num = xs.reduce((s, x, i) => s + (x - mx) * (values[i]! - my), 0)
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0)
  return den === 0 ? 0 : num / den
}

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return 0
  const mx = mean(xs.slice(0, n))
  const my = mean(ys.slice(0, n))
  const num = xs.slice(0, n).reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0)
  const den = Math.sqrt(
    xs.slice(0, n).reduce((s, x) => s + (x - mx) ** 2, 0) *
    ys.slice(0, n).reduce((s, y) => s + (y - my) ** 2, 0),
  )
  return den === 0 ? 0 : num / den
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// Filter timed entries to those within the last `ms` milliseconds of `nowMs`
export function lastMs<T extends { ts: number }>(arr: T[], nowMs: number, ms: number): T[] {
  const cutoff = nowMs - ms
  return arr.filter(e => e.ts >= cutoff)
}

// Map a signed value to 'up'/'down'/'neutral' using a deadband threshold
export function toDirection(
  value: number,
  deadband = 0.05,
): 'up' | 'down' | 'neutral' {
  if (value > deadband)  return 'up'
  if (value < -deadband) return 'down'
  return 'neutral'
}

// Neutral signal score constant
export function neutral(): import('./types.js').SignalScore {
  return { value: 0, confidence: 0, direction: 'neutral', components: {} }
}
