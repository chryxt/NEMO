import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { FeatureStore } from './FeatureStore'
import { extractFeatures } from './features'
import { computeSignals, computeComposite } from './signals'
import { classifyRegime } from './RegimeClassifier'
import type { MarketSymbol } from '../types/market'
import type { SignalFrame } from './types'

export class SignalEngine {
  private readonly store = new FeatureStore()
  private latestNowSec   = 0
  private started        = false

  start(): void {
    if (this.started) return
    this.started = true

    // ── Feed store: update history on every data event ────────────────────

    bus.on('oracle.price',    (e) => {
      this.store.updateOracle(e)
      // Oracle price is the trigger: compute + emit signal frame
      this.compute(e.symbol, e.ts)
    })

    bus.on('trade.activity',  (e) => this.store.updateTrade(e))
    bus.on('clob.bestBidAsk', (e) => this.store.updateBestBidAsk(e))
    bus.on('clob.priceChange',(e) => this.store.updatePriceChange(e))
    bus.on('clob.book',       (e) => this.store.updateBook(e))
    bus.on('whale.alert',     (e) => this.store.updateWhale(e))

    bus.on('market.tick',     (e) => {
      this.store.updateClock(e)
      this.latestNowSec = e.nowSec
    })

    bus.on('market.windowOpen', (e) => this.store.resetWindow(e))

    log.info('[SignalEngine] started')
  }

  stop(): void {
    log.info('[SignalEngine] stopped')
  }

  // ── Signal computation ────────────────────────────────────────────────────

  private compute(symbol: MarketSymbol, nowMs: number): void {
    const t0 = process.hrtime.bigint()

    const symStore = this.store.symbols[symbol]
    const features = extractFeatures(symStore, symbol, nowMs, this.latestNowSec)
    const signals  = computeSignals(features)
    const regime   = classifyRegime(features)
    const composite = computeComposite(signals)

    const frame: SignalFrame = {
      symbol, ts: nowMs, nowSec: this.latestNowSec,
      features, signals, regime, composite,
    }

    const latencyUs = Number(process.hrtime.bigint() - t0) / 1_000

    bus.emit('signal.frame', { frame, latencyUs })

    log.trace(`[Signal] ${symbol} regime=${regime} composite=${composite.value.toFixed(3)} conf=${composite.confidence.toFixed(2)} [${latencyUs.toFixed(0)}µs]`)
  }
}
