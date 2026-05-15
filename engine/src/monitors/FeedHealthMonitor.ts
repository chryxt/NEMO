import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { SYMBOLS } from '../types/market.js'
import type { MarketSymbol } from '../types/market.js'
import { config } from '../config/index.js'

export type FeedStatus = 'healthy' | 'warning' | 'stale'

export interface SymbolOracleHealth {
  status: FeedStatus
  ageSecs: number | null
}

export interface FeedHealth {
  oracle: Record<MarketSymbol, SymbolOracleHealth>
  clob: { status: FeedStatus; ageSecs: number | null }
  degraded: boolean
}

const CHECK_INTERVAL_MS = 5_000

export class FeedHealthMonitor {
  private lastOracleMs: Record<MarketSymbol, number | null> = { BTC: null, ETH: null, SOL: null }
  private lastClobMs: number | null = null

  // Previous statuses for edge-detection (emit events only on transitions)
  private prevOracleStatus: Record<MarketSymbol, FeedStatus> = { BTC: 'healthy', ETH: 'healthy', SOL: 'healthy' }
  private prevClobStatus: FeedStatus = 'healthy'
  private isDegraded = false

  private checkTimer: NodeJS.Timeout | null = null

  start(): void {
    bus.on('oracle.price', (e) => { this.lastOracleMs[e.symbol] = Date.now() })

    const onClob = () => { this.lastClobMs = Date.now() }
    bus.on('clob.book',        onClob)
    bus.on('clob.bestBidAsk',  onClob)
    bus.on('clob.priceChange', onClob)
    bus.on('clob.lastTrade',   onClob)

    this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer)
  }

  private feedStatus(lastMs: number | null, warnSecs: number, staleSecs: number): FeedStatus {
    if (lastMs === null) return 'stale'
    const age = (Date.now() - lastMs) / 1_000
    if (age > staleSecs) return 'stale'
    if (age > warnSecs)  return 'warning'
    return 'healthy'
  }

  private check(): void {
    const oWarn  = config.oracleStaleSecs * 0.5
    const oStale = config.oracleStaleSecs
    const cWarn  = config.orderbookStaleSecs * 0.5
    const cStale = config.orderbookStaleSecs

    for (const sym of SYMBOLS) {
      const next = this.feedStatus(this.lastOracleMs[sym], oWarn, oStale)
      const prev = this.prevOracleStatus[sym]
      if (next !== prev) {
        if (next === 'stale' || next === 'warning') {
          const age = this.lastOracleMs[sym] ? (Date.now() - this.lastOracleMs[sym]!) / 1_000 : null
          bus.emit('system.warning', {
            source:    `${sym} oracle`,
            message:   `${sym} oracle feed ${next}`,
            staleSecs: age ?? 0,
          })
          log.warn(`[Health] ${sym} oracle ${next} (${age?.toFixed(0) ?? '?'}s ago)`)
        } else {
          bus.emit('system.recovered', { source: `${sym} oracle` })
          log.info(`[Health] ${sym} oracle recovered`)
        }
        this.prevOracleStatus[sym] = next
      }
    }

    const nextClob = this.feedStatus(this.lastClobMs, cWarn, cStale)
    if (nextClob !== this.prevClobStatus) {
      if (nextClob === 'stale' || nextClob === 'warning') {
        const age = this.lastClobMs ? (Date.now() - this.lastClobMs) / 1_000 : null
        bus.emit('system.warning', {
          source:    'CLOB orderbook',
          message:   `CLOB feed ${nextClob}`,
          staleSecs: age ?? 0,
        })
        log.warn(`[Health] CLOB orderbook ${nextClob} (${age?.toFixed(0) ?? '?'}s ago)`)
      } else {
        bus.emit('system.recovered', { source: 'CLOB orderbook' })
        log.info('[Health] CLOB orderbook recovered')
      }
      this.prevClobStatus = nextClob
    }

    // Degraded = any oracle stale AND clob stale simultaneously
    const anyOracleStale = SYMBOLS.some((s) => this.prevOracleStatus[s] === 'stale')
    const degraded       = anyOracleStale && this.prevClobStatus === 'stale'
    if (degraded && !this.isDegraded) {
      bus.emit('system.degraded', { reason: 'Oracle and CLOB feeds both stale' })
      log.error('[Health] SYSTEM DEGRADED — oracle and CLOB both stale')
      this.isDegraded = true
    } else if (!degraded && this.isDegraded) {
      this.isDegraded = false
    }
  }

  // Called by Terminal on each render frame — always returns fresh status from timestamps
  getHealth(): FeedHealth {
    const now = Date.now()
    const oWarn  = config.oracleStaleSecs * 0.5
    const oStale = config.oracleStaleSecs
    const cWarn  = config.orderbookStaleSecs * 0.5
    const cStale = config.orderbookStaleSecs

    const oracle = {} as Record<MarketSymbol, SymbolOracleHealth>
    for (const sym of SYMBOLS) {
      const lastMs = this.lastOracleMs[sym]
      oracle[sym] = {
        status:  this.feedStatus(lastMs, oWarn, oStale),
        ageSecs: lastMs !== null ? (now - lastMs) / 1_000 : null,
      }
    }

    const lastClob = this.lastClobMs
    const clob = {
      status:  this.feedStatus(lastClob, cWarn, cStale),
      ageSecs: lastClob !== null ? (now - lastClob) / 1_000 : null,
    }

    const degraded = SYMBOLS.some((s) => oracle[s].status === 'stale') && clob.status === 'stale'

    return { oracle, clob, degraded }
  }
}
