import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import { config } from '../config/index'
import { RingBuffer } from '../utils/RingBuffer'

const RATE_WINDOW_SECS   = 10      // rolling window for msg/sec rates
const MEM_WARN_INTERVAL  = 60_000  // warn at most once per minute

export interface EngineMetrics {
  // Message rates — rolling average over last 10 seconds
  oracleMsgRate: number
  tradeMsgRate: number
  clobMsgRate: number

  // Total event counts since start
  totalOraclePrices: number
  totalTrades: number
  totalClobEvents: number

  // Connection health
  rtdsReconnects: number
  clobReconnects: number
  rtdsConnectedSinceMs: number | null
  clobConnectedSinceMs: number | null

  // Memory
  heapUsedMb: number
  rssMb: number

  // Timing
  uptimeSecs: number
  sampledAtMs: number
}

export class MetricsEngine {
  // Per-second count buckets, capped at RATE_WINDOW_SECS entries
  private oracleBuckets = new RingBuffer<number>(RATE_WINDOW_SECS)
  private tradeBuckets  = new RingBuffer<number>(RATE_WINDOW_SECS)
  private clobBuckets   = new RingBuffer<number>(RATE_WINDOW_SECS)

  // Current-second accumulators (flushed every 1s)
  private oracleCurrent = 0
  private tradeCurrent  = 0
  private clobCurrent   = 0

  // Totals
  private totalOracle = 0
  private totalTrades = 0
  private totalClob   = 0

  // Connection
  private rtdsReconnects = 0
  private clobReconnects = 0
  private rtdsConnectedSinceMs: number | null = null
  private clobConnectedSinceMs: number | null = null

  private startedAt       = Date.now()
  private lastMemWarnMs   = 0
  private bucketTimer: NodeJS.Timeout | null = null

  start(): void {
    bus.on('oracle.price', () => { this.oracleCurrent++; this.totalOracle++ })
    bus.on('trade.activity', () => { this.tradeCurrent++; this.totalTrades++ })

    const onClob = () => { this.clobCurrent++; this.totalClob++ }
    bus.on('clob.book',        onClob)
    bus.on('clob.bestBidAsk',  onClob)
    bus.on('clob.priceChange', onClob)
    bus.on('clob.lastTrade',   onClob)

    bus.on('connection.change', (e) => {
      if (e.status === 'reconnecting') {
        if (e.service === 'rtds') this.rtdsReconnects++
        else                      this.clobReconnects++
      }
      if (e.status === 'connected') {
        if (e.service === 'rtds') this.rtdsConnectedSinceMs = Date.now()
        else                      this.clobConnectedSinceMs = Date.now()
      }
    })

    this.bucketTimer = setInterval(() => this.flushBucket(), 1_000)
  }

  stop(): void {
    if (this.bucketTimer) clearInterval(this.bucketTimer)
  }

  private flushBucket(): void {
    this.oracleBuckets.push(this.oracleCurrent)
    this.tradeBuckets.push(this.tradeCurrent)
    this.clobBuckets.push(this.clobCurrent)
    this.oracleCurrent = 0
    this.tradeCurrent  = 0
    this.clobCurrent   = 0
  }

  private rate(buf: RingBuffer<number>): number {
    const arr = buf.toArray()
    if (arr.length === 0) return 0
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }

  getMetrics(): EngineMetrics {
    const mem      = process.memoryUsage()
    const heapMb   = mem.heapUsed / 1_048_576
    const now      = Date.now()

    if (heapMb > config.memoryWarnMb && now - this.lastMemWarnMs > MEM_WARN_INTERVAL) {
      log.warn(`[Metrics] memory pressure: heap ${heapMb.toFixed(1)}MB exceeds ${config.memoryWarnMb}MB threshold`)
      this.lastMemWarnMs = now
    }

    return {
      oracleMsgRate: this.rate(this.oracleBuckets),
      tradeMsgRate:  this.rate(this.tradeBuckets),
      clobMsgRate:   this.rate(this.clobBuckets),
      totalOraclePrices: this.totalOracle,
      totalTrades:       this.totalTrades,
      totalClobEvents:   this.totalClob,
      rtdsReconnects:         this.rtdsReconnects,
      clobReconnects:         this.clobReconnects,
      rtdsConnectedSinceMs:   this.rtdsConnectedSinceMs,
      clobConnectedSinceMs:   this.clobConnectedSinceMs,
      heapUsedMb: heapMb,
      rssMb:       mem.rss / 1_048_576,
      uptimeSecs:  Math.floor((Date.now() - this.startedAt) / 1_000),
      sampledAtMs: Date.now(),
    }
  }
}
