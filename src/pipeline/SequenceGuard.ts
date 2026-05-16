import { log } from '../utils/logger.js'

export interface SequenceStats {
  processed: number
  duplicates: number
  outOfOrder: number
}

// Drop exact-duplicate events seen within this window
const DEDUPE_WINDOW_MS = 5_000
// Warn (but still process) events arriving this far behind the last seen ts
const OOO_TOLERANCE_MS = 10_000
// Max fingerprints in dedupe cache before eviction
const CACHE_MAX = 500

export class SequenceGuard {
  private readonly cache = new Map<string, number>()  // fingerprint → first-seen wallclock ms
  private lastEventTsMs = 0
  private readonly stats: SequenceStats = { processed: 0, duplicates: 0, outOfOrder: 0 }

  constructor(private readonly feedName: string) {}

  /**
   * Returns true if the event should be processed, false if it should be dropped.
   * @param fingerprint  A compact string uniquely identifying the event's key fields.
   * @param eventTsMs    The event's own timestamp in milliseconds (0 = unknown).
   */
  check(fingerprint: string, eventTsMs: number): boolean {
    const now = Date.now()

    // Deduplicate: same fingerprint seen recently → drop
    const firstSeen = this.cache.get(fingerprint)
    if (firstSeen !== undefined && now - firstSeen < DEDUPE_WINDOW_MS) {
      this.stats.duplicates++
      log.debug(`[${this.feedName}] duplicate dropped (age ${now - firstSeen}ms): ${fingerprint.slice(0, 48)}`)
      return false
    }

    // Out-of-order: warn but still process — OOO events carry valid state
    if (eventTsMs > 0 && this.lastEventTsMs > 0 && eventTsMs < this.lastEventTsMs - OOO_TOLERANCE_MS) {
      this.stats.outOfOrder++
      log.warn(`[${this.feedName}] out-of-order event: ts=${eventTsMs} last=${this.lastEventTsMs} delta=${this.lastEventTsMs - eventTsMs}ms`)
    }

    // Evict stale cache entries if at capacity
    if (this.cache.size >= CACHE_MAX) this.evict(now)

    this.cache.set(fingerprint, now)
    if (eventTsMs > this.lastEventTsMs) this.lastEventTsMs = eventTsMs
    this.stats.processed++
    return true
  }

  getStats(): Readonly<SequenceStats> {
    return { ...this.stats }
  }

  private evict(now: number): void {
    const cutoff = now - DEDUPE_WINDOW_MS
    for (const [fp, ts] of this.cache) {
      if (ts < cutoff) this.cache.delete(fp)
      // Stop evicting once we're below 70% capacity
      if (this.cache.size < CACHE_MAX * 0.7) break
    }
  }
}
