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
    const nowSec = Math.floor(Date.now() / 1000)
    const windowTs = nowSec - (nowSec % 300)
    const closeTs = windowTs + 300
    const secondsRemaining = closeTs - nowSec

    bus.emit('market.tick', {
      window: { windowTs, closeTs, secondsRemaining },
    })

    // New window detected
    if (windowTs !== this.lastWindowTs) {
      const isFirst = this.lastWindowTs === 0
      this.lastWindowTs = windowTs
      if (!isFirst) {
        log.info(`[Clock] new window opened: ${windowTs} → ${closeTs}`)
      }
      // Fire-and-forget; token IDs fetched async
      this.fetchAndBroadcastTokenIds(windowTs, closeTs).catch((err) => {
        log.warn(`[Clock] token ID fetch failed: ${err?.message ?? err}`)
      })
    }
  }

  private async fetchAndBroadcastTokenIds(windowTs: number, closeTs: number): Promise<void> {
    const results = await Promise.allSettled(
      SYMBOLS.map((sym) => this.fetchTokenIds(sym, windowTs))
    )

    let anyUpdated = false
    results.forEach((result, i) => {
      const sym = SYMBOLS[i]!
      if (result.status === 'fulfilled' && result.value) {
        this.tokenIds[sym] = result.value
        anyUpdated = true
      } else if (result.status === 'rejected') {
        log.warn(`[Clock] failed to fetch ${sym} token IDs: ${result.reason?.message}`)
      }
    })

    if (!anyUpdated) return

    const event: MarketWindowOpenEvent = {
      windowTs,
      closeTs,
      tokenIds: { ...this.tokenIds },
    }
    bus.emit('market.windowOpen', event)
    log.info(`[Clock] token IDs refreshed for window ${windowTs}`)
  }

  private async fetchTokenIds(symbol: MarketSymbol, windowTs: number): Promise<TokenIdPair | null> {
    const slug = `${SLUG_PREFIX[symbol]}-${windowTs}`
    const url = `${GAMMA_URL}/events?slug=${slug}&limit=1`

    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { 'User-Agent': 'polymarket-engine/0.1' },
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${slug}`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json()
    const events = Array.isArray(data) ? data : data?.events ?? []
    if (!events.length) {
      log.debug(`[Clock] no event found for slug: ${slug}`)
      return null
    }

    const event = events[0]
    const markets: unknown[] = event?.markets ?? []
    if (!markets.length) {
      log.debug(`[Clock] no markets in event for slug: ${slug}`)
      return null
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const market: any = markets[0]
    const tokenIds: string[] = market?.clobTokenIds ?? []

    return {
      up: tokenIds[0] ?? null,
      down: tokenIds[1] ?? null,
    }
  }
}
