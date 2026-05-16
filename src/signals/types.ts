import type { MarketSymbol } from '../types/market.js'

// ── Regime ────────────────────────────────────────────────────────────────────

export type MarketRegime =
  | 'trending_up'
  | 'trending_down'
  | 'choppy'
  | 'illiquid'
  | 'whale_driven'
  | 'volatile'
  | 'compressed'

// ── Features ──────────────────────────────────────────────────────────────────

export interface OracleFeatures {
  price:         number | null
  momentum30s:   number | null   // absolute price change over last 30s (USD)
  momentum60s:   number | null   // absolute price change over last 60s (USD)
  volatility30s: number | null   // std dev of 1s return fractions over 30s
  acceleration:  number | null   // change in momentum per second
  zscore60s:     number | null   // (price - sma60s) / std60s
}

export interface OrderflowFeatures {
  cumulativeDelta: number   // buy USD - sell USD over 60s
  imbalance:       number   // cumulativeDelta / totalVol, clamped -1..+1
  buyVolume:       number   // buy USD over 60s
  sellVolume:      number   // sell USD over 60s
  tradeCount:      number   // total trades over 60s
  deltaVelocity:   number   // cumulativeDelta / elapsed_secs (USD/sec)
  tradeVelocity:   number   // trades / 60s
}

export interface QuoteFeatures {
  bid:           number | null
  ask:           number | null
  mid:           number | null
  spread:        number | null
  spreadMA:      number | null   // mean spread over 120s
  spreadZscore:  number | null   // (spread - spreadMA) / spreadStd
  spreadSlope:   number | null   // linear slope of spread over 30s (units/sec)
  midVelocity:   number | null   // mid price change per second (30s window)
  midAccel:      number | null   // change in midVelocity per second
}

export interface WhaleFeatures {
  delta60s:      number          // whale buy - sell USD over 60s
  volume60s:     number          // total whale USD over 60s
  count60s:      number          // whale trade count over 60s
  concentration: number          // whaleVolume / totalTradeVolume, 0..1
  aggression:    number          // whale trades per minute over 60s
  dominantSide:  'buy' | 'sell' | 'neutral'
}

export interface WindowFeatures {
  windowTs:       number
  secondsToClose: number
  windowProgress: number    // fraction 0..1 of 300s window elapsed
  isNearSettle:   boolean   // true when < 30s to close
}

export interface FeatureSnapshot {
  symbol:    MarketSymbol
  ts:        number           // Unix ms (oracle event timestamp — deterministic)
  nowSec:    number           // logical clock second (from market.tick)
  oracle:    OracleFeatures
  orderflow: OrderflowFeatures
  quotes:    QuoteFeatures
  whales:    WhaleFeatures
  window:    WindowFeatures
}

// ── Signal scores ─────────────────────────────────────────────────────────────

export interface SignalScore {
  value:      number           // -1.0 to +1.0
  confidence: number           // 0.0 to 1.0
  direction:  'up' | 'down' | 'neutral'
  components: Record<string, number>
}

export interface SignalSet {
  orderflow:   SignalScore
  momentum:    SignalScore
  spread:      SignalScore
  whale:       SignalScore
  positioning: SignalScore
}

export interface CompositeSignal {
  value:      number    // weighted average of signal values
  confidence: number    // weighted average confidence
  direction:  'up' | 'down' | 'neutral'
  agreement:  number    // fraction of non-neutral signals agreeing on direction (0..1)
}

// ── Signal frame (emitted to bus) ─────────────────────────────────────────────

export interface SignalFrame {
  symbol:    MarketSymbol
  ts:        number
  nowSec:    number
  features:  FeatureSnapshot
  signals:   SignalSet
  regime:    MarketRegime
  composite: CompositeSignal
}

// ── Research types ────────────────────────────────────────────────────────────

export interface ForwardStats {
  horizon:    number   // ms
  hitRate:    number   // 0..1
  avgReturn:  number   // mean forward return (fraction)
  pearson:    number   // correlation between signal value and return
  sampleN:    number
}

export interface SignalStats {
  signalName:      string
  symbol:          MarketSymbol
  sampleCount:     number
  persistence:     number   // autocorrelation of direction (0..1)
  falsePositiveRate: number
  horizons:        ForwardStats[]  // [5s, 30s, 60s]
  regimeBreakdown: Partial<Record<MarketRegime, number>>
}

export interface ResearchReport {
  sessionId:     string
  replaySource:  'file' | 'db'
  fromTs:        number
  toTs:          number
  frameCount:    number
  durationSecs:  number
  stats:         SignalStats[]
  regimeDist:    Partial<Record<MarketRegime, number>>
  outputDir:     string
}

// ── Signal observability ──────────────────────────────────────────────────────

export interface SignalObservabilityMetrics {
  framesComputed:      number
  framesPerSec:        number
  avgComputeLatencyUs: number
  p99ComputeLatencyUs: number
  directionFlips:      number
  regimeTransitions:   number
  highConfidenceRate:  number   // fraction of frames with composite.confidence > 0.6
}
