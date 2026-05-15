/**
 * Pure feature extraction functions.
 * All functions are deterministic given the same store state and nowMs.
 * No mutations, no bus emissions, no side effects.
 */
import type { MarketSymbol } from '../types/market.js'
import type { FeatureSnapshot, OracleFeatures, OrderflowFeatures, QuoteFeatures, WhaleFeatures, WindowFeatures } from './types.js'
import type { SymbolStore } from './FeatureStore.js'
import { mean, stdDev, linearSlope, lastMs } from './math.js'

// Lookback windows (milliseconds)
const W30  =  30_000
const W60  =  60_000
const W120 = 120_000

// ── Oracle features ───────────────────────────────────────────────────────────

function oracleFeatures(store: SymbolStore, nowMs: number): OracleFeatures {
  const all    = store.oracleHistory.toArray()
  const hist30 = lastMs(all, nowMs, W30)
  const hist60 = lastMs(all, nowMs, W60)

  const latest = all[all.length - 1]
  const price  = latest?.price ?? null

  // Momentum: price change over lookback
  const momentum30s = hist30.length >= 2
    ? hist30[hist30.length - 1]!.price - hist30[0]!.price
    : null

  const momentum60s = hist60.length >= 2
    ? hist60[hist60.length - 1]!.price - hist60[0]!.price
    : null

  // Volatility: std dev of 1s returns over 30s
  // A return is (price[i] - price[i-1]) / price[i-1]
  let volatility30s: number | null = null
  if (hist30.length >= 3 && price) {
    const returns: number[] = []
    for (let i = 1; i < hist30.length; i++) {
      const prev = hist30[i - 1]!.price
      if (prev !== 0) returns.push((hist30[i]!.price - prev) / prev)
    }
    volatility30s = returns.length >= 2 ? stdDev(returns) : null
  }

  // Acceleration: how fast momentum is changing (compare last-15s vs previous-15s)
  let acceleration: number | null = null
  if (hist30.length >= 4) {
    const mid = Math.floor(hist30.length / 2)
    const firstHalf  = hist30.slice(0, mid)
    const secondHalf = hist30.slice(mid)
    const mom1 = firstHalf[firstHalf.length - 1]!.price - firstHalf[0]!.price
    const mom2 = secondHalf[secondHalf.length - 1]!.price - secondHalf[0]!.price
    const secs = (secondHalf[0]!.ts - firstHalf[0]!.ts) / 1000
    acceleration = secs > 0 ? (mom2 - mom1) / secs : null
  }

  // Z-score: how far current price is from 60s mean (normalized by std)
  let zscore60s: number | null = null
  if (hist60.length >= 5 && price) {
    const prices = hist60.map(e => e.price)
    const mu  = mean(prices)
    const sig = stdDev(prices, mu)
    zscore60s = sig > 0 ? (price - mu) / sig : 0
  }

  return { price, momentum30s, momentum60s, volatility30s, acceleration, zscore60s }
}

// ── Orderflow features ────────────────────────────────────────────────────────

function orderflowFeatures(store: SymbolStore, nowMs: number): OrderflowFeatures {
  const trades = lastMs(store.tradeHistory.toArray(), nowMs, W60)

  const buyVolume  = trades.filter(t => t.side === 'BUY').reduce((s, t) => s + t.sizeUsd, 0)
  const sellVolume = trades.filter(t => t.side === 'SELL').reduce((s, t) => s + t.sizeUsd, 0)
  const totalVol   = buyVolume + sellVolume
  const delta      = buyVolume - sellVolume

  const imbalance    = totalVol > 0 ? delta / totalVol : 0
  const tradeCount   = trades.length
  const tradeVelocity = tradeCount  // per 60s window

  // Delta velocity: rate of accumulation (USD/sec) using linear slope
  let deltaVelocity = 0
  if (trades.length >= 2) {
    // Build cumulative delta series over time
    const sorted = [...trades].sort((a, b) => a.ts - b.ts)
    let cum = 0
    const cumSeries = sorted.map(t => {
      cum += t.side === 'BUY' ? t.sizeUsd : -t.sizeUsd
      return cum
    })
    const slope = linearSlope(cumSeries)
    const secSpan = (sorted[sorted.length - 1]!.ts - sorted[0]!.ts) / 1000
    deltaVelocity = secSpan > 0 ? slope / secSpan : 0
  }

  return {
    cumulativeDelta: delta,
    imbalance,
    buyVolume,
    sellVolume,
    tradeCount,
    deltaVelocity,
    tradeVelocity,
  }
}

// ── Quote features ────────────────────────────────────────────────────────────

function quoteFeatures(store: SymbolStore, nowMs: number): QuoteFeatures {
  const latest = store.quoteHistory.last()
  if (!latest) {
    return { bid: null, ask: null, mid: null, spread: null,
             spreadMA: null, spreadZscore: null, spreadSlope: null,
             midVelocity: null, midAccel: null }
  }

  const { bid, ask, mid, spread } = latest

  // Spread MA and z-score over 120s
  const hist120 = lastMs(store.quoteHistory.toArray(), nowMs, W120)
  let spreadMA: number | null = null
  let spreadZscore: number | null = null
  if (hist120.length >= 5) {
    const spreads = hist120.map(q => q.spread)
    const mu  = mean(spreads)
    const sig = stdDev(spreads, mu)
    spreadMA    = mu
    spreadZscore = sig > 0 ? (spread - mu) / sig : 0
  }

  // Spread slope over 30s (linear trend: negative = compressing)
  const hist30 = lastMs(hist120, nowMs, W30)
  let spreadSlope: number | null = null
  if (hist30.length >= 3) {
    const spreads = hist30.map(q => q.spread)
    const slope = linearSlope(spreads)
    const secSpan = (hist30[hist30.length - 1]!.ts - hist30[0]!.ts) / 1000
    spreadSlope = secSpan > 0 ? slope / secSpan : 0
  }

  // Mid price velocity over 30s (change per second)
  let midVelocity: number | null = null
  let midAccel: number | null = null
  if (hist30.length >= 2) {
    const first = hist30[0]!
    const last  = hist30[hist30.length - 1]!
    const secs  = (last.ts - first.ts) / 1000
    if (secs > 0) {
      midVelocity = (last.mid - first.mid) / secs
    }

    // Acceleration: compare velocity in first vs second half
    if (hist30.length >= 4) {
      const midIdx = Math.floor(hist30.length / 2)
      const h1 = hist30.slice(0, midIdx)
      const h2 = hist30.slice(midIdx)
      const v1secs = (h1[h1.length - 1]!.ts - h1[0]!.ts) / 1000
      const v2secs = (h2[h2.length - 1]!.ts - h2[0]!.ts) / 1000
      const v1 = v1secs > 0 ? (h1[h1.length - 1]!.mid - h1[0]!.mid) / v1secs : 0
      const v2 = v2secs > 0 ? (h2[h2.length - 1]!.mid - h2[0]!.mid) / v2secs : 0
      const accelSecs = (h2[0]!.ts - h1[0]!.ts) / 1000
      midAccel = accelSecs > 0 ? (v2 - v1) / accelSecs : null
    }
  }

  return { bid, ask, mid, spread, spreadMA, spreadZscore, spreadSlope, midVelocity, midAccel }
}

// ── Whale features ────────────────────────────────────────────────────────────

function whaleFeatures(store: SymbolStore, nowMs: number, totalTradeVol: number): WhaleFeatures {
  const whales = lastMs(store.whaleHistory.toArray(), nowMs, W60)

  const buyVol  = whales.filter(w => w.side === 'BUY').reduce((s, w) => s + w.sizeUsd, 0)
  const sellVol = whales.filter(w => w.side === 'SELL').reduce((s, w) => s + w.sizeUsd, 0)
  const volume60s = buyVol + sellVol
  const delta60s  = buyVol - sellVol
  const count60s  = whales.length

  const concentration = totalTradeVol > 0 ? volume60s / totalTradeVol : 0
  const aggression    = count60s  // trades per 60s window

  const dominantSide: 'buy' | 'sell' | 'neutral' =
    delta60s > 0 ? 'buy' : delta60s < 0 ? 'sell' : 'neutral'

  return { delta60s, volume60s, count60s, concentration, aggression, dominantSide }
}

// ── Window features ───────────────────────────────────────────────────────────

function windowFeatures(store: SymbolStore, nowMs: number): WindowFeatures {
  const { windowTs, closeTs } = store
  const WINDOW_SECS    = 300
  const nowSec         = nowMs / 1000
  const secondsToClose = Math.max(0, closeTs - nowSec)
  const windowProgress = windowTs > 0
    ? Math.min(1, (nowSec - windowTs) / WINDOW_SECS)
    : 0

  return {
    windowTs,
    secondsToClose,
    windowProgress,
    isNearSettle: secondsToClose < 30,
  }
}

// ── Full snapshot ─────────────────────────────────────────────────────────────

export function extractFeatures(
  store:   SymbolStore,
  symbol:  MarketSymbol,
  nowMs:   number,
  nowSec:  number,
): FeatureSnapshot {
  const oracle    = oracleFeatures(store, nowMs)
  const orderflow = orderflowFeatures(store, nowMs)
  const quotes    = quoteFeatures(store, nowMs)
  const whales    = whaleFeatures(store, nowMs, orderflow.buyVolume + orderflow.sellVolume)
  const window    = windowFeatures(store, nowMs)

  return { symbol, ts: nowMs, nowSec, oracle, orderflow, quotes, whales, window }
}
