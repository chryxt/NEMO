/**
 * Market regime classification.
 * Pure function — same FeatureSnapshot always produces the same regime.
 * Priority order: whale_driven > volatile > compressed > illiquid > trending > choppy
 */
import type { FeatureSnapshot, MarketRegime } from './types'

// Thresholds (all configurable via this module — no env vars, keeps it testable)
const WHALE_DRIVEN_THRESHOLD  = 0.30   // whale % of total volume
const VOLATILE_THRESHOLD      = 0.0005 // std dev of 1s returns (0.05% = high vol)
const COMPRESSED_THRESHOLD    = 0.00005// std dev of 1s returns (0.005% = very calm)
const ILLIQUID_THRESHOLD      = 2.0   // spread z-score
const TREND_THRESHOLD         = 0.30  // |orderflow imbalance|

export function classifyRegime(f: FeatureSnapshot): MarketRegime {
  // 1. Whale-driven: large informed participants dominating flow
  if (f.whales.concentration > WHALE_DRIVEN_THRESHOLD) return 'whale_driven'

  // 2. Volatility regimes (oracle-based)
  if (f.oracle.volatility30s != null) {
    if (f.oracle.volatility30s > VOLATILE_THRESHOLD)    return 'volatile'
    if (f.oracle.volatility30s < COMPRESSED_THRESHOLD)  return 'compressed'
  }

  // 3. Illiquid: spread significantly wider than normal
  if (f.quotes.spreadZscore != null && f.quotes.spreadZscore > ILLIQUID_THRESHOLD) {
    return 'illiquid'
  }

  // 4. Trending: sustained orderflow imbalance
  const imb = Math.abs(f.orderflow.imbalance)
  if (imb > TREND_THRESHOLD) {
    return f.orderflow.imbalance > 0 ? 'trending_up' : 'trending_down'
  }

  // 5. Default: choppy / indeterminate
  return 'choppy'
}
