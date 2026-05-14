import { WsBase } from '../WsBase.js'
import { bus } from '../../bus/EventBus.js'
import { normalizeClob } from './ClobNormalizer.js'
import { log } from '../../utils/logger.js'

const CLOB_WS_URL =
  process.env['CLOB_WS_URL'] ?? 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

export class ClobClient extends WsBase {
  private subscribedTokenIds = new Set<string>()

  constructor() {
    super({
      url: CLOB_WS_URL,
      name: 'CLOB',
      pingIntervalMs: 10_000,
      pongTimeoutMs: 35_000,
    })
  }

  protected onOpen(): void {
    bus.emit('connection.change', { service: 'clob', status: 'connected' })
    // Re-subscribe to any existing token IDs (handles reconnect case)
    if (this.subscribedTokenIds.size > 0) {
      this.subscribeToTokenIds([...this.subscribedTokenIds])
    }
  }

  protected onMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      log.debug(`[CLOB] non-JSON: ${raw.slice(0, 80)}`)
      return
    }

    const msg = normalizeClob(parsed)

    switch (msg.type) {
      case 'book':        bus.emit('clob.book', msg.data); break
      case 'bestBidAsk':  bus.emit('clob.bestBidAsk', msg.data); break
      case 'priceChange': bus.emit('clob.priceChange', msg.data); break
      case 'lastTrade':   bus.emit('clob.lastTrade', msg.data); break
      case 'tickSizeChange': bus.emit('clob.tickSizeChange', msg.data); break
    }
  }

  protected onStatusChange(status: typeof this.status): void {
    bus.emit('connection.change', { service: 'clob', status })
  }

  updateSubscriptions(tokenIds: string[]): void {
    const incoming = new Set(tokenIds.filter(Boolean))
    const toAdd = [...incoming].filter((id) => !this.subscribedTokenIds.has(id))
    const toRemove = [...this.subscribedTokenIds].filter((id) => !incoming.has(id))

    if (toRemove.length > 0) {
      this.unsubscribeFromTokenIds(toRemove)
      toRemove.forEach((id) => this.subscribedTokenIds.delete(id))
    }

    if (toAdd.length > 0) {
      this.subscribeToTokenIds(toAdd)
      toAdd.forEach((id) => this.subscribedTokenIds.add(id))
    }
  }

  private subscribeToTokenIds(ids: string[]): void {
    if (ids.length === 0) return
    log.info(`[CLOB] subscribing to ${ids.length} token(s): ${ids.map((id) => id.slice(0, 8) + '…').join(', ')}`)
    this.send({
      assets_ids: ids,
      type: 'market',
      custom_feature_enabled: true,
    })
  }

  private unsubscribeFromTokenIds(ids: string[]): void {
    if (ids.length === 0) return
    log.info(`[CLOB] unsubscribing ${ids.length} token(s)`)
    this.send({
      assets_ids: ids,
      type: 'market',
      operation: 'unsubscribe',
    })
  }
}
