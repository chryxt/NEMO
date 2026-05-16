/**
 * Dataset curator — writes tagged JSONL streams of live observations for
 * future ML readiness. Each record includes regime + anomaly flags so
 * datasets can be filtered downstream by market conditions.
 *
 * NOT a training pipeline. NO ML. NO predictions. Just labeled storage.
 *
 * Files: <outputDir>/datasets/<YYYY-MM-DD>/{signals,fills,whales,anomalies}.jsonl
 */
import { createWriteStream, mkdirSync } from 'fs'
import type { WriteStream } from 'fs'
import { join } from 'path'
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import type { SimulationEngine } from '../sim/SimulationEngine.js'
import type { DatasetTags } from './types.js'
import type { SimFill } from '../sim/types.js'

const FLUSH_INTERVAL_MS = 5_000

interface Stream {
  path:   string
  out:    WriteStream
  buffer: string[]
  count:  number
}

export class DatasetCurator {
  private streams = new Map<string, Stream>()
  private currentDate = ''
  private flushTimer: NodeJS.Timeout | null = null

  // Live flags maintained from bus events
  private degraded = false
  private latestRegime: string | null = null
  private fillsSeen = new Set<string>()
  private records = 0

  // For dedup of fills
  constructor(
    private readonly outputDir: string,
    private readonly sim: SimulationEngine,
  ) {}

  start(): void {
    this.currentDate = dateUtc(Date.now())
    this.openStreamsForDate(this.currentDate)

    bus.on('system.degraded', () => { this.degraded = true })
    bus.on('system.recovered', () => { this.degraded = false })

    bus.on('signal.frame', ({ frame, latencyUs }) => {
      this.latestRegime = frame.regime
      this.maybeRollover()
      this.write('signals', {
        ts:         frame.ts,
        wall:       Date.now(),
        symbol:     frame.symbol,
        regime:     frame.regime,
        confidence: frame.composite.confidence,
        direction:  frame.composite.direction,
        agreement:  frame.composite.agreement,
        value:      frame.composite.value,
        features:   frame.features,
        signals:    frame.signals,
        latencyUs,
        tags:       this.currentTags(),
      })
    })

    bus.on('whale.alert', ({ trade }) => {
      this.maybeRollover()
      this.write('whales', {
        ts:        trade.ts,
        wall:      Date.now(),
        symbol:    trade.symbol,
        outcome:   trade.outcome,
        side:      trade.side,
        sizeUsd:   trade.sizeUsd,
        price:     trade.price,
        wallet:    trade.wallet,
        tags:      this.currentTags(),
      })
    })

    bus.on('drift.alert', (e) => {
      this.maybeRollover()
      this.write('anomalies', {
        ts:       Date.now(),
        type:     'drift',
        metric:   e.metric,
        drift:    e.drift,
        severity: e.severity,
        baseline: e.baseline,
        current:  e.current,
        tags:     this.currentTags(),
      })
    })

    bus.on('ops.structuralBreak', (e) => {
      this.maybeRollover()
      this.write('anomalies', {
        ts:        Date.now(),
        type:      'structural-break',
        metric:    e.metric,
        cusum:     e.cusum,
        threshold: e.threshold,
        tags:      this.currentTags(),
      })
    })

    bus.on('system.warning', (e) => {
      this.maybeRollover()
      this.write('anomalies', {
        ts:     Date.now(),
        type:   'system-warning',
        source: e.source,
        message: e.message,
        tags:   this.currentTags(),
      })
    })

    // Periodically scan portfolio for new fills
    bus.on('market.tick', () => this.scanFills())

    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS)
    log.info(`[DatasetCurator] writing labeled datasets → ${this.outputDir}/datasets/${this.currentDate}/`)
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushAll()
    for (const s of this.streams.values()) s.out.end()
    log.info(`[DatasetCurator] closed — ${this.records} records written`)
  }

  getRecordCount(): number { return this.records }

  // ── Internal ────────────────────────────────────────────────────────────────

  private currentTags(): DatasetTags {
    return {
      regime:     this.latestRegime,
      drift:      false,    // set per-record by anomaly stream itself
      killActive: this.sim.isKillSwitchActive(),
      degraded:   this.degraded,
    }
  }

  private scanFills(): void {
    const fills = this.sim.getPortfolio().getFills()
    for (const f of fills) {
      const key = `${f.orderId}:${f.ts}:${f.side}`
      if (this.fillsSeen.has(key)) continue
      this.fillsSeen.add(key)
      this.writeFill(f)
    }
  }

  private writeFill(f: SimFill): void {
    this.maybeRollover()
    this.write('fills', {
      ts:            f.ts,
      wall:          Date.now(),
      orderId:       f.orderId,
      symbol:        f.symbol,
      outcome:       f.outcome,
      side:          f.side,
      price:         f.price,
      size:          f.size,
      fee:           f.fee,
      slippageBps:   f.slippageBps,
      spreadCostBps: f.spreadCostBps,
      depthCostBps:  f.depthCostBps,
      tags:          this.currentTags(),
    })
  }

  private maybeRollover(): void {
    const today = dateUtc(Date.now())
    if (today === this.currentDate) return
    // Close yesterday's streams and start today's
    this.flushAll()
    for (const s of this.streams.values()) s.out.end()
    this.streams.clear()
    this.currentDate = today
    this.openStreamsForDate(today)
    log.info(`[DatasetCurator] rolled over to ${today}`)
  }

  private openStreamsForDate(dateStr: string): void {
    const dir = join(this.outputDir, 'datasets', dateStr)
    mkdirSync(dir, { recursive: true })
    for (const name of ['signals', 'fills', 'whales', 'anomalies']) {
      const path = join(dir, `${name}.jsonl`)
      this.streams.set(name, {
        path,
        out:    createWriteStream(path, { flags: 'a' }),
        buffer: [],
        count:  0,
      })
    }
  }

  private write(stream: string, record: unknown): void {
    const s = this.streams.get(stream)
    if (!s) return
    s.buffer.push(JSON.stringify(record))
    s.count++
    this.records++
    if (s.buffer.length >= 500) this.flushOne(s)
  }

  private flushOne(s: Stream): void {
    if (s.buffer.length === 0) return
    s.out.write(s.buffer.join('\n') + '\n')
    s.buffer = []
  }

  private flushAll(): void {
    for (const s of this.streams.values()) this.flushOne(s)
  }
}

function dateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
