import { createWriteStream, mkdirSync } from 'fs'
import type { WriteStream } from 'fs'
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'

const FLUSH_EVERY   = 1000  // flush every N events
const FLUSH_INTERVAL_MS = 5_000

export class EventRecorder {
  private stream: WriteStream
  private buffer: string[] = []
  private count = 0
  private flushTimer: NodeJS.Timeout | null = null

  constructor(outPath: string) {
    const dir = outPath.substring(0, outPath.lastIndexOf('/'))
    if (dir) mkdirSync(dir, { recursive: true })
    this.stream = createWriteStream(outPath, { flags: 'a' })
    log.info(`[Recorder] recording events → ${outPath}`)
  }

  start(): void {
    bus.tap((event, payload) => {
      this.buffer.push(JSON.stringify({ ts: Date.now(), event, payload }))
      this.count++
      if (this.buffer.length >= FLUSH_EVERY) this.flush()
    })

    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flush()
    log.info(`[Recorder] closed — ${this.count} events recorded`)
    this.stream.end()
  }

  private flush(): void {
    if (this.buffer.length === 0) return
    this.stream.write(this.buffer.join('\n') + '\n')
    this.buffer = []
  }
}
