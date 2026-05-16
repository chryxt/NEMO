import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { bus } from '../bus/EventBus'
import { log } from '../utils/logger'
import type { BusEvents } from '../types/events'

interface RecordedEvent {
  ts: number
  event: string
  payload: unknown
}

export class EventReplayer {
  constructor(
    private readonly filePath: string,
    private readonly speedMultiplier: number = 1.0,  // 0 = instant, >0 = N× realtime
  ) {}

  async start(): Promise<void> {
    log.info(`[Replayer] loading ${this.filePath} (speed: ${this.speedMultiplier === 0 ? 'instant' : `${this.speedMultiplier}×`})`)

    const events = await this.loadFile()
    if (events.length === 0) {
      log.warn('[Replayer] replay file is empty or unreadable')
      return
    }

    log.info(`[Replayer] replaying ${events.length} events`)

    const firstTs    = events[0]!.ts
    const replayStart = Date.now()

    for (const ev of events) {
      if (this.speedMultiplier > 0) {
        const originalElapsed = ev.ts - firstTs
        const targetElapsed   = originalElapsed / this.speedMultiplier
        const actualElapsed   = Date.now() - replayStart
        const delay = targetElapsed - actualElapsed
        if (delay > 1) await sleep(delay)
      }

      try {
        bus.emit(ev.event as keyof BusEvents, ev.payload as BusEvents[keyof BusEvents])
      } catch {
        // Skip unknown event types gracefully
      }
    }

    log.info('[Replayer] replay complete')
  }

  private async loadFile(): Promise<RecordedEvent[]> {
    const events: RecordedEvent[] = []
    const rl = createInterface({ input: createReadStream(this.filePath) })

    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed) as RecordedEvent)
      } catch {
        log.warn(`[Replayer] skipping malformed line: ${trimmed.slice(0, 80)}`)
      }
    }

    return events
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
