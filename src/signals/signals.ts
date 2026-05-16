/**
 * Pure signal computation functions.
 * Each signal takes a FeatureSnapshot and returns a SignalScore.
 * No state, no side effects, fully deterministic.
 *
 * Signal values: -1.0 (strong bearish/down) to +1.0 (strong bullish/up)
 * Confidence:    0.0 (no signal) to 1.0 (maximum conviction)
 */
import type { FeatureSnapshot, SignalScore, SignalSet, CompositeSignal } from './types.js'
import { clamp, toDirection, neutral } from './math.js'

// Signal weights for composite (must sum to 1.0)
const WEIGHTS: Record<keyof SignalSet, number> = {
  orderflow:   0.30,
  momentum:    0.25,
  spread:      0.15,
  whale:       0.20,
  positioning: 0.10,
}

// ── Orderflow signal ──────────────────────────────────────────────────────────
// Premise: cumulative buy/sell imbalance predicts short-term price direction.

export function orderflowSignal(f: FeatureSnapshot): SignalScore {
  const { imbalance, deltaVelocity, tradeCount } = f.orderflow

  if (tradeCount < 3) return neutral()

  // Base from imbalance (-1..+1)
  const base = imbalance

  // Velocity confirmation: if accumulation is accelerating in same direction → boost
  const velFactor = deltaVelocity !== 0
    ? Math.sign(deltaVelocity) === Math.sign(base) ? 1.15 : 0.85
    : 1.0

  const value = clamp(base * velFactor, -1, 1)

  // Confidence scales with trade activity and imbalance magnitude
  const activityScore = Math.min(tradeCount / 10, 1.0)
  const confidence    = clamp(Math.abs(imbalance) * 0.7 + activityScore * 0.3, 0, 1)

  return {
    value, confidence,
    direction: toDirection(value),
    components: { imbalance, deltaVelocity, tradeCount },
  }
}

// ── Momentum signal ───────────────────────────────────────────────────────────
// Premise: oracle price momentum tends to persist over short horizons.

export function momentumSignal(f: FeatureSnapshot): SignalScore {
  const { momentum30s, momentum60s, acceleration, price, volatility30s } = f.oracle

  if (momentum30s == null || price == null || price === 0) return neutral()

  // Normalize to percentage move (1% move on 100k BTC = 0.0001)
  const pct30 = momentum30s / price

  // Scale: 0.5% move → 0.25 signal, 2% → max signal
  const base = clamp(pct30 / 0.02, -1, 1)

  // Acceleration confirmation
  const accelFactor = acceleration != null
    ? Math.sign(acceleration) === Math.sign(base) ? 1.1 : 0.9
    : 1.0

  // 60s consistency: both horizons in same direction boosts confidence
  const consistFactor = momentum60s != null
    ? Math.sign(momentum60s) === Math.sign(momentum30s) ? 1.1 : 0.8
    : 1.0

  const value = clamp(base * accelFactor * consistFactor, -1, 1)

  // Confidence penalized by high volatility (noise)
  const volPenalty = volatility30s != null
    ? Math.max(0.2, 1 - volatility30s / (price * 0.001))
    : 0.5

  const confidence = clamp(Math.abs(base) * volPenalty, 0, 1)

  return {
    value, confidence,
    direction: toDirection(value),
    components: {
      pct30: pct30 * 100,
      base,
      accelFactor,
      consistFactor,
      volPenalty,
    },
  }
}

// ── Spread signal ─────────────────────────────────────────────────────────────
// Premise: spread compression + directional mid movement = informed flow.

export function spreadSignal(f: FeatureSnapshot): SignalScore {
  const { spreadZscore, midVelocity, spread } = f.quotes

  if (spreadZscore == null || spread == null) return neutral()
  if (midVelocity == null || Math.abs(midVelocity) < 1e-6) return neutral()

  // Negative z-score = tighter spread = better liquidity conditions
  const spreadQuality = clamp(-spreadZscore / 2, -1, 1)

  // Direction from mid-price velocity
  const dirSign = Math.sign(midVelocity)
  const value   = clamp(spreadQuality * dirSign, -1, 1)

  // Confidence meaningful only when spread is clearly anomalous
  const confidence = clamp((Math.abs(spreadZscore) - 0.5) / 2.0, 0, 1)

  return {
    value, confidence,
    direction: toDirection(value),
    components: { spreadZscore, midVelocity, spreadQuality },
  }
}

// ── Whale signal ──────────────────────────────────────────────────────────────
// Premise: large informed traders signal near-term direction.

export function whaleSignal(f: FeatureSnapshot): SignalScore {
  const { delta60s, volume60s, concentration, aggression } = f.whales

  // No whale activity → no signal
  if (volume60s < 1) return neutral()

  const normDelta = delta60s / Math.max(volume60s, 1)   // -1..+1

  // High concentration amplifies signal (whales dominating flow)
  const concBoost = Math.min(1 + concentration, 1.5)

  const value = clamp(normDelta * concBoost, -1, 1)

  // Confidence from both concentration and aggression
  const aggrScore = Math.min(aggression / 3, 1.0)    // 3 whales/60s = full
  const confidence = clamp(concentration * 0.6 + aggrScore * 0.4, 0, 1)

  return {
    value, confidence,
    direction: toDirection(value),
    components: { normDelta, concentration, aggression, volume60s },
  }
}

// ── Positioning signal ────────────────────────────────────────────────────────
// Premise: late-window directional flow reflects informed pre-settlement positioning.

export function positioningSignal(f: FeatureSnapshot): SignalScore {
  const { imbalance, tradeCount } = f.orderflow
  const { windowProgress, isNearSettle } = f.window

  // Only meaningful in late window (>60% elapsed)
  if (windowProgress < 0.6) return neutral()
  if (tradeCount < 2) return neutral()

  // Quadratic time weight: stronger near settlement
  const timeFactor = windowProgress ** 2

  const value = clamp(imbalance * timeFactor * 1.5, -1, 1)

  const settleBoost = isNearSettle ? 1.5 : 1.0
  const confidence  = clamp(Math.abs(imbalance) * windowProgress * settleBoost, 0, 1)

  return {
    value, confidence,
    direction: toDirection(value),
    components: { imbalance, windowProgress, timeFactor, settleBoost },
  }
}

// ── Signal set ────────────────────────────────────────────────────────────────

export function computeSignals(f: FeatureSnapshot): SignalSet {
  return {
    orderflow:   orderflowSignal(f),
    momentum:    momentumSignal(f),
    spread:      spreadSignal(f),
    whale:       whaleSignal(f),
    positioning: positioningSignal(f),
  }
}

// ── Composite signal ──────────────────────────────────────────────────────────

export function computeComposite(signals: SignalSet): CompositeSignal {
  const entries = Object.entries(signals) as [keyof SignalSet, SignalScore][]

  // Weighted value and confidence
  const value      = entries.reduce((s, [k, sig]) => s + sig.value      * WEIGHTS[k], 0)
  const confidence = entries.reduce((s, [k, sig]) => s + sig.confidence * WEIGHTS[k], 0)

  const direction  = toDirection(value)

  // Agreement: fraction of non-neutral signals that match composite direction
  const nonNeutral = entries.filter(([, s]) => s.direction !== 'neutral')
  const agreeing   = nonNeutral.filter(([, s]) => s.direction === direction)
  const agreement  = nonNeutral.length === 0 ? 1 : agreeing.length / nonNeutral.length

  return { value: clamp(value, -1, 1), confidence: clamp(confidence, 0, 1), direction, agreement }
}
