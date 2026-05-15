import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { getPool } from '../db/pool.js'
import type { BusEvents } from '../types/events.js'

const KNOWN_EVENT_TYPES = new Set<string>([
  'oracle.price', 'trade.activity',
  'clob.book', 'clob.bestBidAsk', 'clob.priceChange', 'clob.lastTrade', 'clob.tickSizeChange',
  'market.tick', 'market.windowOpen',
  'state.snapshot', 'whale.alert', 'connection.change',
  'system.warning', 'system.degraded', 'system.recovered',
])

const FETCH_BATCH = 500     // rows per DB query
const LOG_EVERY   = 1_000  // log progress every N events

export class DbReplayer {
  private readonly from:  Date
  private readonly to:    Date | null
  private readonly speed: number  // 0 = instant, >0 = Nx realtime

  constructor(opts: { from: Date; to?: Date; speed: number }) {
    this.from  = opts.from
    this.to    = opts.to ?? null
    this.speed = opts.speed
  }

  async start(): Promise<void> {
    log.info('[DbReplayer] starting', {
      from:  this.from.toISOString(),
      to:    this.to?.toISOString() ?? 'end of journal',
      speed: this.speed === 0 ? 'instant' : `${this.speed}×`,
    })

    const pool   = getPool()
    const client = await pool.connect()

    let lastOriginalMs = 0  // ts_wall of first event
    let lastActualMs   = 0  // real clock at first event
    let cursor         = 0  // last processed seq
    let total          = 0

    const toCondition  = this.to ? 'AND ts_wall <= $3' : ''
    const toParam      = this.to ? [this.from.getTime(), this.to.getTime()] : [this.from.getTime()]

    try {
      while (true) {
        const params = toParam.concat([cursor])
        const result = await client.query<{
          seq: string; ts_wall: string; event_type: string; payload: unknown
        }>(
          `SELECT seq, ts_wall, event_type, payload
           FROM replay_events
           WHERE ts_wall >= $1 ${toCondition}
             AND seq > $${toParam.length + 1}
           ORDER BY seq
           LIMIT ${FETCH_BATCH}`,
          params,
        )

        if (result.rows.length === 0) break

        for (const row of result.rows) {
          const origMs = parseInt(row.ts_wall, 10)

          // Compute delay
          if (lastOriginalMs === 0) {
            lastOriginalMs = origMs
            lastActualMs   = Date.now()
          } else if (this.speed > 0) {
            const origElapsed   = origMs - lastOriginalMs
            const actualElapsed = Date.now() - lastActualMs
            const delay         = (origElapsed / this.speed) - actualElapsed
            if (delay > 0) await sleep(delay)
          }

          this.emit(row.event_type, row.payload)
          cursor = parseInt(row.seq, 10)
          total++

          if (total % LOG_EVERY === 0) {
            log.info(`[DbReplayer] replayed ${total} events  seq=${cursor}  ts=${new Date(origMs).toISOString()}`)
          }
        }

        if (result.rows.length < FETCH_BATCH) break
      }
    } finally {
      client.release()
    }

    log.info(`[DbReplayer] complete — ${total} events replayed  last seq=${cursor}`)
  }

  private emit(eventType: string, payload: unknown): void {
    if (!KNOWN_EVENT_TYPES.has(eventType)) {
      log.debug(`[DbReplayer] skipping unknown event type: ${eventType}`)
      return
    }
    bus.emit(eventType as keyof BusEvents, payload as never)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
