import { WsBase } from '../WsBase.js'
import { bus } from '../../bus/EventBus.js'
import { normalizeRtds } from './RtdsNormalizer.js'
import { log } from '../../utils/logger.js'
import { SequenceGuard } from '../../pipeline/SequenceGuard.js'
import { RTDS_CHAINLINK_SYMBOL, RTDS_BINANCE_SYMBOL } from '../../types/market.js'

const RTDS_URL = process.env['RTDS_URL'] ?? 'wss://ws-live-data.polymarket.com'

export class RtdsClient extends WsBase {
  private readonly guard = new SequenceGuard('RTDS')

  constructor() {
    super({
      url:            RTDS_URL,
      name:           'RTDS',
      pingIntervalMs: 5_000,
      pongTimeoutMs:  30_000,
    })
  }

  protected onOpen(): void {
    this.subscribeChainlinkPrices()
    this.subscribeActivityTrades()
    bus.emit('connection.change', { service: 'rtds', status: 'connected' })
  }

  protected onMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      log.debug(`[RTDS] non-JSON: ${raw.slice(0, 80)}`)
      return
    }

    const msg = normalizeRtds(parsed)

    if (msg.type === 'oracle_price' && msg.oraclePrice) {
      const e  = msg.oraclePrice
      // ts is Unix ms from Chainlink; use directly for SequenceGuard
      const fp = `oracle:${e.symbol}:${e.source}:${e.price}:${e.ts}`
      if (!this.guard.check(fp, e.ts)) return
      bus.emit('oracle.price', e)

    } else if (msg.type === 'trade_activity' && msg.tradeActivity) {
      const e = msg.tradeActivity
      // txHash is the canonical on-chain unique ID; fall back to composite key
      const fp = e.txHash
        ? `trade:${e.txHash}`
        : `trade:${e.conditionId}:${e.ts}:${e.side}:${e.sizeShares}`
      // e.ts is Unix seconds — convert to ms for SequenceGuard
      if (!this.guard.check(fp, e.ts * 1000)) return
      bus.emit('trade.activity', e)
    }
  }

  protected onStatusChange(status: typeof this.status): void {
    bus.emit('connection.change', { service: 'rtds', status })
  }

  getGuardStats() {
    return this.guard.getStats()
  }

  private subscribeChainlinkPrices(): void {
    const chainlinkFeeds = Object.values(RTDS_CHAINLINK_SYMBOL)
    this.send({
      action: 'subscribe',
      subscriptions: chainlinkFeeds.map((symbol) => ({
        topic:   'crypto_prices_chainlink',
        type:    'update',
        filters: JSON.stringify({ symbol }),
      })),
    })
    log.info(`[RTDS] subscribed to chainlink prices: ${chainlinkFeeds.join(', ')}`)

    const binanceTickers = Object.values(RTDS_BINANCE_SYMBOL)
    this.send({
      action: 'subscribe',
      subscriptions: binanceTickers.map((symbol) => ({
        topic:   'crypto_prices',
        type:    'update',
        filters: JSON.stringify({ symbol }),
      })),
    })
    log.info(`[RTDS] subscribed to binance prices: ${binanceTickers.join(', ')}`)
  }

  private subscribeActivityTrades(): void {
    this.send({
      action: 'subscribe',
      subscriptions: [
        { topic: 'activity', type: 'trades',         filters: '' },
        { topic: 'activity', type: 'orders_matched', filters: '' },
      ],
    })
    log.info('[RTDS] subscribed to activity/trades')
  }
}
