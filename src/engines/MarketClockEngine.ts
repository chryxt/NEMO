import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { SYMBOLS, SLUG_PREFIX } from '../types/market.js'
import type { MarketSymbol } from '../types/market.js'
import type { MarketWindowOpenEvent } from '../types/events.js'

const GAMMA_URL = process.env['GAMMA_API_URL'] ?? 'https://gamma-api.polymarket.com'
const TICK_INTERVAL_MS = 1_000

interface TokenIdPair {
  up: string | null
  down: string | null
}

export class MarketClockEngine {
  private tickTimer: NodeJS.Timeout | null = null
  private lastWindowTs = 0
  private tokenIds: Record<MarketSymbol, TokenIdPair> = {
    BTC: { up: null, down: null },
    ETH: { up: null, down: null },
    SOL: { up: null, down: null },
  }

  start(): void {
    log.info('[Clock] starting market clock engine')
    this.tick()
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
  }

  getTokenIds(): Record<MarketSymbol, TokenIdPair> {
    return this.tokenIds
  }

  private tick(): void {
    const nowMs  = Date.now()
    const nowSec = Math.floor(nowMs / 1000)
    const windowTs = nowSec - (nowSec % 300)
    const closeTs  = windowTs + 300
    const secondsRemaining = closeTs - nowSec

    bus.emit('market.tick', {
      window: { windowTs, closeTs, secondsRemaining },
      nowSec,
    })

    if (windowTs !== this.lastWindowTs) {
      const isFirst      = this.lastWindowTs === 0
      const prevWindowTs = this.lastWindowTs
      this.lastWindowTs  = windowTs

      if (isFirst) {
        log.info(`[Clock] initial window: ${windowTs} → ${closeTs} (${secondsRemaining}s remaining)`)
      } else {
        // Measure how many ms after the true boundary the tick fired — Node event loop drift
        const boundaryMs = windowTs * 1000
        const driftMs    = nowMs - boundaryMs
        log.info(`[Clock] rollover: ${prevWindowTs} → ${windowTs} (tick drift: +${driftMs}ms)`)
      }

      this.fetchAndBroadcastTokenIds(windowTs, closeTs, nowMs).catch((err: unknown) => {
        log.warn(`[Clock] token ID fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  private async fetchAndBroadcastTokenIds(
    windowTs: number,
    closeTs: number,
    fetchStartMs: number,
  ): Promise<void> {
    const results = await Promise.allSettled(
      SYMBOLS.map((sym) => this.fetchTokenIds(sym, windowTs))
    )

    const fetchMs = Date.now() - fetchStartMs
    if (fetchMs > 5_000) {
      log.warn(`[Clock] slow Gamma fetch: ${fetchMs}ms for window ${windowTs}`)
    } else {
      log.debug(`[Clock] Gamma fetch completed in ${fetchMs}ms`)
    }

    let anyUpdated = false
    results.forEach((result, i) => {
      const sym = SYMBOLS[i]!
      if (result.status === 'fulfilled' && result.value) {
        this.tokenIds[sym] = result.value
        anyUpdated = true
        log.debug(`[Clock] ${sym} token IDs: up=${result.value.up?.slice(0, 8)}… down=${result.value.down?.slice(0, 8)}…`)
      } else if (result.status === 'rejected') {
        log.warn(`[Clock] ${sym} token ID fetch failed: ${result.reason?.message ?? result.reason}`)
      } else {
        log.warn(`[Clock] ${sym} returned no token IDs for window ${windowTs}`)
      }
    })

    if (!anyUpdated) {
      log.warn(`[Clock] all token ID fetches failed for window ${windowTs} — keeping previous IDs`)
      return
    }

    const event: MarketWindowOpenEvent = {
      windowTs,
      closeTs,
      tokenIds: { ...this.tokenIds },
    }
    bus.emit('market.windowOpen', event)
    log.info(`[Clock] market.windowOpen emitted for window ${windowTs} (fetch: ${fetchMs}ms)`)
  }

  private async fetchTokenIds(symbol: MarketSymbol, windowTs: number): Promise<TokenIdPair | null> {
    const slug = `${SLUG_PREFIX[symbol]}-${windowTs}`
    const url  = `${GAMMA_URL}/events?slug=${slug}&limit=1`

    const res = await fetch(url, {
      signal:  AbortSignal.timeout(8_000),
      headers: { 'User-Agent': 'polymarket-engine/0.1' },
    })

    if (!res.ok) throw new Error(`HTTP ${res.status} for ${slug}`)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any   = await res.json()
    const events      = Array.isArray(data) ? data : data?.events ?? []
    if (!events.length) {
      log.debug(`[Clock] no event found for slug: ${slug}`)
      return null
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const market: any  = events[0]?.markets?.[0]
    const tokenIds: string[] = market?.clobTokenIds ?? []

    return {
      up:   tokenIds[0] ?? null,
      down: tokenIds[1] ?? null,
    }
  }
}
