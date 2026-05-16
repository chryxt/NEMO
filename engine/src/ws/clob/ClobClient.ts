import { WsBase } from '../WsBase'
import { bus } from '../../bus/EventBus'
import { normalizeClob } from './ClobNormalizer'
import { log } from '../../utils/logger'
import { SequenceGuard } from '../../pipeline/SequenceGuard'

const CLOB_WS_URL =
  process.env['CLOB_WS_URL'] ?? 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

export class ClobClient extends WsBase {
  private subscribedTokenIds = new Set<string>()
  private readonly guard = new SequenceGuard('CLOB')

  constructor() {
    super({
      url:            CLOB_WS_URL,
      name:           'CLOB',
      pingIntervalMs: 10_000,
      pongTimeoutMs:  35_000,
    })
  }

  protected onOpen(): void {
    bus.emit('connection.change', { service: 'clob', status: 'connected' })
    // Re-subscribe on reconnect — server state is lost
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
      case 'book': {
        const e  = msg.data
        // Fingerprint: tokenId + level count + top bid + top ask + timestamp
        const fp = `book:${e.tokenId}:${e.bids.length}:${e.bids[0]?.price ?? 0}:${e.asks[0]?.price ?? 0}:${e.ts}`
        if (!this.guard.check(fp, e.ts * 1000)) return
        bus.emit('clob.book', e)
        break
      }
      case 'bestBidAsk': {
        const e  = msg.data
        const fp = `bba:${e.tokenId}:${e.bid}:${e.ask}:${e.ts}`
        if (!this.guard.check(fp, e.ts * 1000)) return
        bus.emit('clob.bestBidAsk', e)
        break
      }
      case 'priceChange': {
        const e  = msg.data
        const fp = `pc:${e.tokenId}:${e.price}:${e.size}:${e.side}:${e.ts}`
        if (!this.guard.check(fp, e.ts * 1000)) return
        bus.emit('clob.priceChange', e)
        break
      }
      case 'lastTrade': {
        const e  = msg.data
        const fp = `lt:${e.tokenId}:${e.price}:${e.size}:${e.ts}`
        if (!this.guard.check(fp, e.ts * 1000)) return
        bus.emit('clob.lastTrade', e)
        break
      }
      case 'tickSizeChange': {
        const e  = msg.data
        const fp = `tsc:${e.tokenId}:${e.tickSize}:${e.ts}`
        if (!this.guard.check(fp, e.ts * 1000)) return
        bus.emit('clob.tickSizeChange', e)
        break
      }
    }
  }

  protected onStatusChange(status: typeof this.status): void {
    bus.emit('connection.change', { service: 'clob', status })
  }

  updateSubscriptions(tokenIds: string[]): void {
    const incoming = new Set(tokenIds.filter(Boolean))
    const toAdd    = [...incoming].filter((id) => !this.subscribedTokenIds.has(id))
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

  getGuardStats() {
    return this.guard.getStats()
  }

  private subscribeToTokenIds(ids: string[]): void {
    if (ids.length === 0) return
    log.info(`[CLOB] subscribing to ${ids.length} token(s): ${ids.map((id) => id.slice(0, 8) + '…').join(', ')}`)
    this.send({
      assets_ids:             ids,
      type:                   'market',
      custom_feature_enabled: true,
    })
  }

  private unsubscribeFromTokenIds(ids: string[]): void {
    if (ids.length === 0) return
    log.info(`[CLOB] unsubscribing ${ids.length} token(s)`)
    this.send({
      assets_ids: ids,
      type:       'market',
      operation:  'unsubscribe',
    })
  }
}
