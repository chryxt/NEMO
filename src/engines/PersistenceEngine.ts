import { PoolClient } from 'pg'
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'
import { getPool } from '../db/pool.js'
import { RingBuffer } from '../utils/RingBuffer.js'
import type {
  OraclePriceEvent,
  ActivityTradeEvent,
  WhaleAlertEvent,
  ConnectionEvent,
} from '../types/events.js'
import type { MetricsEngine } from './MetricsEngine.js'
import type { MarketSymbol } from '../types/market.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE   = config.persistenceBatchSize
const FLUSH_MS     = config.persistenceFlushMs
const QUEUE_WARN   = config.persistenceQueueWarn
const QUEUE_MAX    = config.persistenceQueueMax
const MAX_RETRIES  = 3
const DLQ_CAP      = 100
const METRIC_MS    = 60_000  // sample system metrics once per minute

// ── Internal row types ────────────────────────────────────────────────────────

interface QuoteRow {
  ts: Date; tokenId: string; symbol: string; outcome: string
  bid: number; ask: number; spread: number
}

interface TradeRow {
  ts: Date; tokenId: string; symbol: string; outcome: string
  price: number; size: number; side: string
}

interface WindowRow {
  windowTs: number; closeTs: number; symbol: string
  tokenIdUp: string | null; tokenIdDown: string | null
}

interface RetryBatch {
  table: string
  rows:  unknown[]
  attempt: number
  nextRetryMs: number
}

// ── Public metrics ────────────────────────────────────────────────────────────

export interface PersistenceMetrics {
  dropped:             number
  inserted:            number
  retryQueueDepth:     number
  dlqDepth:            number
  lastFlushMs:         number
  lastFlushDurationMs: number
  queueDepths: {
    oracle:      number
    quotes:      number
    trades:      number
    activity:    number
    whales:      number
    windows:     number
    connections: number
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class PersistenceEngine {
  // Per-domain queues (drained each flush cycle)
  private oracleQueue:  OraclePriceEvent[]    = []
  private quotesQueue:  QuoteRow[]             = []
  private tradesQueue:  TradeRow[]             = []
  private activityQueue:ActivityTradeEvent[]   = []
  private whalesQueue:  WhaleAlertEvent[]      = []
  private windowsQueue: WindowRow[]            = []
  private connQueue:    ConnectionEvent[]      = []

  // Retry / dead-letter
  private retryQueue: RetryBatch[] = []
  private dlq = new RingBuffer<RetryBatch>(DLQ_CAP)

  // Token ID → symbol/outcome lookup (updated on market.windowOpen)
  private tokenMap = new Map<string, { symbol: MarketSymbol; outcome: 'up' | 'down' }>()

  // Metrics / state
  private dropped      = 0
  private inserted     = 0
  private lastFlushMs  = 0
  private lastFlushDurationMs = 0
  private lastMetricSampleMs  = 0
  private warnedQueues = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly metricsRef?: MetricsEngine) {}

  start(): void {
    // ── Bus subscriptions (all synchronous, O(1)) ──────────────────────────

    bus.on('oracle.price', (e) => this.push(this.oracleQueue, e, 'oracle'))

    bus.on('clob.book', (e) => {
      const tok = this.lookupToken(e.tokenId)
      if (!tok) return
      const bid    = e.bids[0]?.price
      const ask    = e.asks[0]?.price
      if (bid == null || ask == null) return
      this.push(this.quotesQueue, {
        ts: new Date(e.ts), tokenId: e.tokenId,
        symbol: tok.symbol, outcome: tok.outcome,
        bid, ask, spread: ask - bid,
      }, 'quotes')
    })

    bus.on('clob.bestBidAsk', (e) => {
      const tok = this.lookupToken(e.tokenId)
      if (!tok) return
      this.push(this.quotesQueue, {
        ts: new Date(e.ts), tokenId: e.tokenId,
        symbol: tok.symbol, outcome: tok.outcome,
        bid: e.bid, ask: e.ask, spread: e.ask - e.bid,
      }, 'quotes')
    })

    bus.on('clob.priceChange', (e) => {
      const tok = this.lookupToken(e.tokenId)
      if (!tok) return
      this.push(this.quotesQueue, {
        ts: new Date(e.ts), tokenId: e.tokenId,
        symbol: tok.symbol, outcome: tok.outcome,
        bid: e.bestBid, ask: e.bestAsk, spread: e.bestAsk - e.bestBid,
      }, 'quotes')
      this.push(this.tradesQueue, {
        ts: new Date(e.ts), tokenId: e.tokenId,
        symbol: tok.symbol, outcome: tok.outcome,
        price: e.price, size: e.size, side: e.side,
      }, 'trades')
    })

    bus.on('clob.lastTrade', (e) => {
      const tok = this.lookupToken(e.tokenId)
      if (!tok) return
      this.push(this.tradesQueue, {
        ts: new Date(e.ts), tokenId: e.tokenId,
        symbol: tok.symbol, outcome: tok.outcome,
        price: e.price, size: e.size, side: e.side,
      }, 'trades')
    })

    bus.on('trade.activity',  (e) => this.push(this.activityQueue, e, 'activity'))
    bus.on('whale.alert',     (e) => this.push(this.whalesQueue, e, 'whales'))
    bus.on('connection.change', (e) => this.push(this.connQueue, e, 'connections'))

    bus.on('market.windowOpen', (e) => {
      // Rebuild token lookup map
      this.tokenMap.clear()
      for (const [sym, ids] of Object.entries(e.tokenIds) as [MarketSymbol, { up: string | null; down: string | null }][]) {
        if (ids.up)   this.tokenMap.set(ids.up,   { symbol: sym, outcome: 'up' })
        if (ids.down) this.tokenMap.set(ids.down, { symbol: sym, outcome: 'down' })
      }

      // Enqueue one row per symbol for market_windows
      for (const [sym, ids] of Object.entries(e.tokenIds) as [MarketSymbol, { up: string | null; down: string | null }][]) {
        this.push(this.windowsQueue, {
          windowTs: e.windowTs, closeTs: e.closeTs, symbol: sym,
          tokenIdUp: ids.up, tokenIdDown: ids.down,
        }, 'windows')
      }
    })

    // ── Flush timer ────────────────────────────────────────────────────────
    this.flushTimer = setInterval(() => { void this.flush() }, FLUSH_MS)
    log.info('[PersistenceEngine] started')
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    log.info(`[PersistenceEngine] stopped — inserted: ${this.inserted}  dropped: ${this.dropped}`)
  }

  getPersistenceMetrics(): PersistenceMetrics {
    return {
      dropped:             this.dropped,
      inserted:            this.inserted,
      retryQueueDepth:     this.retryQueue.length,
      dlqDepth:            this.dlq.size,
      lastFlushMs:         this.lastFlushMs,
      lastFlushDurationMs: this.lastFlushDurationMs,
      queueDepths: {
        oracle:      this.oracleQueue.length,
        quotes:      this.quotesQueue.length,
        trades:      this.tradesQueue.length,
        activity:    this.activityQueue.length,
        whales:      this.whalesQueue.length,
        windows:     this.windowsQueue.length,
        connections: this.connQueue.length,
      },
    }
  }

  // ── Private: enqueue ──────────────────────────────────────────────────────

  private push<T>(queue: T[], item: T, name: string): void {
    if (queue.length >= QUEUE_MAX) {
      this.dropped++
      if (this.dropped % 500 === 1) {
        log.warn(`[PersistenceEngine] queue "${name}" full (${QUEUE_MAX}), total dropped: ${this.dropped}`)
      }
      return
    }
    if (queue.length === QUEUE_WARN && !this.warnedQueues.has(name)) {
      this.warnedQueues.add(name)
      bus.emit('system.warning', {
        source:    'persistence',
        message:   `write queue "${name}" depth reached ${QUEUE_WARN} — DB flush may be slow`,
        staleSecs: 0,
      })
    } else if (queue.length < QUEUE_WARN) {
      this.warnedQueues.delete(name)
    }
    queue.push(item)
  }

  private lookupToken(tokenId: string): { symbol: MarketSymbol; outcome: 'up' | 'down' } | null {
    return this.tokenMap.get(tokenId) ?? null
  }

  // ── Private: flush cycle ──────────────────────────────────────────────────

  private async flush(): Promise<void> {
    const start = Date.now()
    let client: PoolClient | undefined

    try {
      client = await getPool().connect()
    } catch (err) {
      log.warn(`[PersistenceEngine] DB connect failed: ${(err as Error).message}`)
      this.lastFlushDurationMs = Date.now() - start
      return
    }

    try {
      await this.drainOracle(client)
      await this.drainQuotes(client)
      await this.drainTrades(client)
      await this.drainActivity(client)
      await this.drainWhales(client)
      await this.drainWindows(client)
      await this.drainConns(client)
      await this.drainMetrics(client)
      await this.processRetries(client)
    } finally {
      client.release()
      this.lastFlushDurationMs = Date.now() - start
      this.lastFlushMs = Date.now()
    }
  }

  // ── Private: drain helpers ────────────────────────────────────────────────

  private async drainOracle(client: PoolClient): Promise<void> {
    if (this.oracleQueue.length === 0) return
    const batch = this.oracleQueue.splice(0, BATCH_SIZE)
    try {
      await client.query(
        `INSERT INTO oracle_ticks (ts, symbol, price, source)
         SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::numeric[], $4::text[])`,
        [
          batch.map(r => new Date(r.ts)),
          batch.map(r => r.symbol),
          batch.map(r => r.price),
          batch.map(r => r.source),
        ],
      )
      this.inserted += batch.length
    } catch (err) {
      log.warn(`[PersistenceEngine] oracle_ticks insert failed: ${(err as Error).message}`)
      this.scheduleRetry('oracle_ticks', batch)
    }
  }

  private async drainQuotes(client: PoolClient): Promise<void> {
    if (this.quotesQueue.length === 0) return
    const batch = this.quotesQueue.splice(0, BATCH_SIZE)
    try {
      await client.query(
        `INSERT INTO clob_quotes (ts, token_id, symbol, outcome, bid, ask, spread)
         SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[])`,
        [
          batch.map(r => r.ts),
          batch.map(r => r.tokenId),
          batch.map(r => r.symbol),
          batch.map(r => r.outcome),
          batch.map(r => r.bid),
          batch.map(r => r.ask),
          batch.map(r => r.spread),
        ],
      )
      this.inserted += batch.length
    } catch (err) {
      log.warn(`[PersistenceEngine] clob_quotes insert failed: ${(err as Error).message}`)
      this.scheduleRetry('clob_quotes', batch)
    }
  }

  private async drainTrades(client: PoolClient): Promise<void> {
    if (this.tradesQueue.length === 0) return
    const batch = this.tradesQueue.splice(0, BATCH_SIZE)
    try {
      await client.query(
        `INSERT INTO clob_trades (ts, token_id, symbol, outcome, price, size, side)
         SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[])`,
        [
          batch.map(r => r.ts),
          batch.map(r => r.tokenId),
          batch.map(r => r.symbol),
          batch.map(r => r.outcome),
          batch.map(r => r.price),
          batch.map(r => r.size),
          batch.map(r => r.side),
        ],
      )
      this.inserted += batch.length
    } catch (err) {
      log.warn(`[PersistenceEngine] clob_trades insert failed: ${(err as Error).message}`)
      this.scheduleRetry('clob_trades', batch)
    }
  }

  private async drainActivity(client: PoolClient): Promise<void> {
    if (this.activityQueue.length === 0) return
    const batch = this.activityQueue.splice(0, BATCH_SIZE)
    try {
      await client.query(
        `INSERT INTO trade_activity
           (ts, condition_id, event_slug, outcome, side, size_shares, price, wallet, pseudonym, tx_hash)
         SELECT * FROM UNNEST(
           $1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[],
           $6::numeric[], $7::numeric[], $8::text[], $9::text[], $10::text[]
         )
         ON CONFLICT (tx_hash, ts) DO NOTHING`,
        [
          batch.map(r => new Date(r.ts * 1000)),
          batch.map(r => r.conditionId),
          batch.map(r => r.eventSlug),
          batch.map(r => r.outcome),
          batch.map(r => r.side),
          batch.map(r => r.sizeShares),
          batch.map(r => r.price),
          batch.map(r => r.wallet),
          batch.map(r => r.pseudonym ?? null),
          batch.map(r => r.txHash),
        ],
      )
      this.inserted += batch.length
    } catch (err) {
      log.warn(`[PersistenceEngine] trade_activity insert failed: ${(err as Error).message}`)
      this.scheduleRetry('trade_activity', batch)
    }
  }

  private async drainWhales(client: PoolClient): Promise<void> {
    if (this.whalesQueue.length === 0) return
    const batch = this.whalesQueue.splice(0, BATCH_SIZE)
    try {
      await client.query(
        `INSERT INTO whale_events (ts, symbol, outcome, side, size_usd, price, wallet)
         SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[])`,
        [
          batch.map(r => new Date(r.trade.ts * 1000)),
          batch.map(r => r.trade.symbol),
          batch.map(r => r.trade.outcome),
          batch.map(r => r.trade.side),
          batch.map(r => r.trade.sizeUsd),
          batch.map(r => r.trade.price),
          batch.map(r => r.trade.wallet),
        ],
      )
      this.inserted += batch.length
    } catch (err) {
      log.warn(`[PersistenceEngine] whale_events insert failed: ${(err as Error).message}`)
      this.scheduleRetry('whale_events', batch)
    }
  }

  private async drainWindows(client: PoolClient): Promise<void> {
    if (this.windowsQueue.length === 0) return
    const batch = this.windowsQueue.splice(0, BATCH_SIZE)
    try {
      await client.query(
        `INSERT INTO market_windows (window_ts, close_ts, symbol, token_id_up, token_id_down)
         SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[])
         ON CONFLICT (window_ts, symbol) DO NOTHING`,
        [
          batch.map(r => r.windowTs),
          batch.map(r => r.closeTs),
          batch.map(r => r.symbol),
          batch.map(r => r.tokenIdUp ?? null),
          batch.map(r => r.tokenIdDown ?? null),
        ],
      )
      this.inserted += batch.length
    } catch (err) {
      log.warn(`[PersistenceEngine] market_windows insert failed: ${(err as Error).message}`)
      this.scheduleRetry('market_windows', batch)
    }
  }

  private async drainConns(client: PoolClient): Promise<void> {
    if (this.connQueue.length === 0) return
    const batch = this.connQueue.splice(0, BATCH_SIZE)
    try {
      await client.query(
        `INSERT INTO connection_events (ts, service, status, attempt)
         SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::integer[])`,
        [
          batch.map(() => new Date()),
          batch.map(r => r.service),
          batch.map(r => r.status),
          batch.map(r => r.attempt ?? null),
        ],
      )
      this.inserted += batch.length
    } catch (err) {
      log.warn(`[PersistenceEngine] connection_events insert failed: ${(err as Error).message}`)
      this.scheduleRetry('connection_events', batch)
    }
  }

  private async drainMetrics(client: PoolClient): Promise<void> {
    if (!this.metricsRef) return
    const now = Date.now()
    if (now - this.lastMetricSampleMs < METRIC_MS) return
    this.lastMetricSampleMs = now

    const m = this.metricsRef.getMetrics()
    try {
      await client.query(
        `INSERT INTO system_metrics
           (ts, oracle_msg_rate, trade_msg_rate, clob_msg_rate,
            heap_mb, rss_mb, uptime_secs,
            oracle_total, trade_total, clob_total,
            rtds_reconnects, clob_reconnects)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          new Date(m.sampledAtMs),
          m.oracleMsgRate, m.tradeMsgRate, m.clobMsgRate,
          m.heapUsedMb, m.rssMb, m.uptimeSecs,
          m.totalOraclePrices, m.totalTrades, m.totalClobEvents,
          m.rtdsReconnects, m.clobReconnects,
        ],
      )
      this.inserted++
    } catch (err) {
      log.warn(`[PersistenceEngine] system_metrics insert failed: ${(err as Error).message}`)
    }
  }

  // ── Private: retry / dead-letter ─────────────────────────────────────────

  private scheduleRetry(table: string, rows: unknown[]): void {
    this.retryQueue.push({ table, rows, attempt: 0, nextRetryMs: Date.now() + 1_000 })
  }

  private async processRetries(client: PoolClient): Promise<void> {
    const now    = Date.now()
    const active = this.retryQueue.filter(b => b.nextRetryMs <= now)
    const later  = this.retryQueue.filter(b => b.nextRetryMs >  now)
    this.retryQueue = later

    for (const batch of active) {
      try {
        await this.retryInsert(client, batch)
        this.inserted += batch.rows.length
        log.debug(`[PersistenceEngine] retry succeeded for ${batch.table} (attempt ${batch.attempt + 1})`)
      } catch (err) {
        const next = batch.attempt + 1
        if (next >= MAX_RETRIES) {
          log.error(`[PersistenceEngine] ${batch.table} batch failed after ${MAX_RETRIES} retries — moving to DLQ`)
          this.dlq.push(batch)
        } else {
          const delay = Math.pow(2, next) * 1_000
          this.retryQueue.push({ ...batch, attempt: next, nextRetryMs: Date.now() + delay })
          log.debug(`[PersistenceEngine] ${batch.table} retry ${next}/${MAX_RETRIES} in ${delay}ms`)
        }
      }
    }
  }

  private async retryInsert(client: PoolClient, batch: RetryBatch): Promise<void> {
    switch (batch.table) {
      case 'oracle_ticks':     return this.drainOracleRows(client, batch.rows as OraclePriceEvent[])
      case 'clob_quotes':      return this.drainQuoteRows(client, batch.rows as QuoteRow[])
      case 'clob_trades':      return this.drainTradeRows(client, batch.rows as TradeRow[])
      case 'trade_activity':   return this.drainActivityRows(client, batch.rows as ActivityTradeEvent[])
      case 'whale_events':     return this.drainWhaleRows(client, batch.rows as WhaleAlertEvent[])
      case 'market_windows':   return this.drainWindowRows(client, batch.rows as WindowRow[])
      case 'connection_events':return this.drainConnRows(client, batch.rows as ConnectionEvent[])
      default: log.warn(`[PersistenceEngine] unknown retry table: ${batch.table}`)
    }
  }

  // ── Private: raw insert helpers (used by drain + retry) ──────────────────

  private async drainOracleRows(client: PoolClient, rows: OraclePriceEvent[]): Promise<void> {
    await client.query(
      `INSERT INTO oracle_ticks (ts, symbol, price, source)
       SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::numeric[], $4::text[])`,
      [rows.map(r => new Date(r.ts)), rows.map(r => r.symbol), rows.map(r => r.price), rows.map(r => r.source)],
    )
  }

  private async drainQuoteRows(client: PoolClient, rows: QuoteRow[]): Promise<void> {
    await client.query(
      `INSERT INTO clob_quotes (ts, token_id, symbol, outcome, bid, ask, spread)
       SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[])`,
      [rows.map(r => r.ts), rows.map(r => r.tokenId), rows.map(r => r.symbol), rows.map(r => r.outcome),
       rows.map(r => r.bid), rows.map(r => r.ask), rows.map(r => r.spread)],
    )
  }

  private async drainTradeRows(client: PoolClient, rows: TradeRow[]): Promise<void> {
    await client.query(
      `INSERT INTO clob_trades (ts, token_id, symbol, outcome, price, size, side)
       SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[])`,
      [rows.map(r => r.ts), rows.map(r => r.tokenId), rows.map(r => r.symbol), rows.map(r => r.outcome),
       rows.map(r => r.price), rows.map(r => r.size), rows.map(r => r.side)],
    )
  }

  private async drainActivityRows(client: PoolClient, rows: ActivityTradeEvent[]): Promise<void> {
    await client.query(
      `INSERT INTO trade_activity
         (ts, condition_id, event_slug, outcome, side, size_shares, price, wallet, pseudonym, tx_hash)
       SELECT * FROM UNNEST(
         $1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[],
         $6::numeric[], $7::numeric[], $8::text[], $9::text[], $10::text[]
       )
       ON CONFLICT (tx_hash, ts) DO NOTHING`,
      [rows.map(r => new Date(r.ts * 1000)), rows.map(r => r.conditionId), rows.map(r => r.eventSlug),
       rows.map(r => r.outcome), rows.map(r => r.side), rows.map(r => r.sizeShares),
       rows.map(r => r.price), rows.map(r => r.wallet), rows.map(r => r.pseudonym ?? null), rows.map(r => r.txHash)],
    )
  }

  private async drainWhaleRows(client: PoolClient, rows: WhaleAlertEvent[]): Promise<void> {
    await client.query(
      `INSERT INTO whale_events (ts, symbol, outcome, side, size_usd, price, wallet)
       SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[])`,
      [rows.map(r => new Date(r.trade.ts * 1000)), rows.map(r => r.trade.symbol), rows.map(r => r.trade.outcome),
       rows.map(r => r.trade.side), rows.map(r => r.trade.sizeUsd), rows.map(r => r.trade.price), rows.map(r => r.trade.wallet)],
    )
  }

  private async drainWindowRows(client: PoolClient, rows: WindowRow[]): Promise<void> {
    await client.query(
      `INSERT INTO market_windows (window_ts, close_ts, symbol, token_id_up, token_id_down)
       SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[])
       ON CONFLICT (window_ts, symbol) DO NOTHING`,
      [rows.map(r => r.windowTs), rows.map(r => r.closeTs), rows.map(r => r.symbol),
       rows.map(r => r.tokenIdUp ?? null), rows.map(r => r.tokenIdDown ?? null)],
    )
  }

  private async drainConnRows(client: PoolClient, rows: ConnectionEvent[]): Promise<void> {
    await client.query(
      `INSERT INTO connection_events (ts, service, status, attempt)
       SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::integer[])`,
      [rows.map(() => new Date()), rows.map(r => r.service), rows.map(r => r.status), rows.map(r => r.attempt ?? null)],
    )
  }
}

