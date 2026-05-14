import { WsBase } from '../WsBase.js'
import { bus } from '../../bus/EventBus.js'
import { normalizeRtds } from './RtdsNormalizer.js'
import { log } from '../../utils/logger.js'
import { RTDS_CHAINLINK_SYMBOL, RTDS_BINANCE_SYMBOL } from '../../types/market.js'

const RTDS_URL = process.env['RTDS_URL'] ?? 'wss://ws-live-data.polymarket.com'

export class RtdsClient extends WsBase {
  constructor() {
    super({
      url: RTDS_URL,
      name: 'RTDS',
      pingIntervalMs: 5_000,
      pongTimeoutMs: 30_000,
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
      bus.emit('oracle.price', msg.oraclePrice)
    } else if (msg.type === 'trade_activity' && msg.tradeActivity) {
      bus.emit('trade.activity', msg.tradeActivity)
    }
  }

  protected onStatusChange(status: typeof this.status): void {
    bus.emit('connection.change', { service: 'rtds', status })
  }

  private subscribeChainlinkPrices(): void {
    // One subscription per symbol (RTDS only supports one symbol per connection
    // for crypto_prices, but crypto_prices_chainlink accepts multiple via wildcard)
    const chainlinkFeeds = Object.values(RTDS_CHAINLINK_SYMBOL)
    this.send({
      action: 'subscribe',
      subscriptions: chainlinkFeeds.map((symbol) => ({
        topic: 'crypto_prices_chainlink',
        type: 'update',
        filters: JSON.stringify({ symbol }),
      })),
    })
    log.info(`[RTDS] subscribed to chainlink prices: ${chainlinkFeeds.join(', ')}`)

    // Also subscribe Binance as secondary
    const binanceTickers = Object.values(RTDS_BINANCE_SYMBOL)
    this.send({
      action: 'subscribe',
      subscriptions: binanceTickers.map((symbol) => ({
        topic: 'crypto_prices',
        type: 'update',
        filters: JSON.stringify({ symbol }),
      })),
    })
    log.info(`[RTDS] subscribed to binance prices: ${binanceTickers.join(', ')}`)
  }

  private subscribeActivityTrades(): void {
    this.send({
      action: 'subscribe',
      subscriptions: [
        { topic: 'activity', type: 'trades', filters: '' },
        { topic: 'activity', type: 'orders_matched', filters: '' },
      ],
    })
    log.info('[RTDS] subscribed to activity/trades')
  }
}
