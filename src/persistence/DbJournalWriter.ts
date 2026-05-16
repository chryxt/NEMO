import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'
import { getPool } from '../db/pool.js'

// Events that carry meaningful replay data.
// Excludes: state.snapshot (derived/large), market.tick (high-freq/derived).
const JOURNAL_EVENTS = new Set([
  'oracle.price',
  'trade.activity',
  'clob.book',
  'clob.bestBidAsk',
  'clob.priceChange',
  'clob.lastTrade',
  'clob.tickSizeChange',
  'market.windowOpen',
  'whale.alert',
  'connection.change',
  'system.warning',
  'system.degraded',
  'system.recovered',
])

const FLUSH_MS    = config.persistenceFlushMs
const BATCH_SIZE  = config.persistenceBatchSize
const QUEUE_MAX   = 10_000  // larger cap — journal must be complete

interface JournalRow {
  tsWall:    number
  eventType: string
  payload:   unknown
}

export class DbJournalWriter {
  private queue: JournalRow[]             = []
  private dropped                          = 0
  private inserted                         = 0
  private flushTimer: NodeJS.Timeout | null = null

  start(): void {
    bus.tapMany((eventType, payload) => {
      if (!JOURNAL_EVENTS.has(eventType)) return

      if (this.queue.length >= QUEUE_MAX) {
        this.dropped++
        if (this.dropped % 1000 === 1) {
          log.warn(`[DbJournalWriter] journal queue full, total dropped: ${this.dropped}`)
        }
        return
      }
      this.queue.push({ tsWall: Date.now(), eventType, payload })
    })

    this.flushTimer = setInterval(() => { void this.flush() }, FLUSH_MS)
    log.info('[DbJournalWriter] started')
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    log.info(`[DbJournalWriter] stopped — inserted: ${this.inserted}  dropped: ${this.dropped}`)
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return

    const batch = this.queue.splice(0, BATCH_SIZE)
    let client
    try {
      client = await getPool().connect()
    } catch (err) {
      // Put batch back and retry next cycle
      this.queue.unshift(...batch)
      log.warn(`[DbJournalWriter] DB connect failed: ${(err as Error).message}`)
      return
    }

    try {
      await client.query(
        `INSERT INTO replay_events (ts_wall, event_type, payload, version)
         SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::jsonb[], $4::smallint[])`,
        [
          batch.map(r => r.tsWall),
          batch.map(r => r.eventType),
          batch.map(r => JSON.stringify(r.payload)),
          batch.map(() => 1),
        ],
      )
      this.inserted += batch.length
    } catch (err) {
      log.error(`[DbJournalWriter] journal insert failed: ${(err as Error).message}`)
      // Re-queue for retry only if there's room — journal completeness is best-effort
      if (this.queue.length + batch.length <= QUEUE_MAX) {
        this.queue.unshift(...batch)
      } else {
        this.dropped += batch.length
        log.error(`[DbJournalWriter] dropped ${batch.length} journal rows (queue full after insert failure)`)
      }
    } finally {
      client.release()
    }
  }
}
