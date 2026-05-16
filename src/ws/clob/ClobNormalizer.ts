import type {
  ClobBookEvent,
  ClobBestBidAskEvent,
  ClobPriceChangeEvent,
  ClobLastTradeEvent,
  ClobTickSizeChangeEvent,
} from '../../types/events.js'

export type NormalizedClobMessage =
  | { type: 'book'; data: ClobBookEvent }
  | { type: 'bestBidAsk'; data: ClobBestBidAskEvent }
  | { type: 'priceChange'; data: ClobPriceChangeEvent }
  | { type: 'lastTrade'; data: ClobLastTradeEvent }
  | { type: 'tickSizeChange'; data: ClobTickSizeChangeEvent }
  | { type: 'unknown' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeClob(parsed: any): NormalizedClobMessage {
  const eventType: string = parsed?.event_type ?? parsed?.type ?? ''
  const ts = Number(parsed?.timestamp ?? Math.floor(Date.now() / 1000))
  const tokenId: string = parsed?.asset_id ?? parsed?.token_id ?? ''

  switch (eventType) {
    case 'book': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapLevels = (arr: any[] = []) =>
        arr.map((l: { price: string; size: string }) => ({
          price: Number(l.price),
          size: Number(l.size),
        }))
      return {
        type: 'book',
        data: {
          tokenId,
          bids: mapLevels(parsed.bids),
          asks: mapLevels(parsed.asks),
          ts,
        },
      }
    }

    case 'price_change': {
      const bid = Number(parsed.best_bid ?? parsed.bestBid ?? 0)
      const ask = Number(parsed.best_ask ?? parsed.bestAsk ?? 0)
      return {
        type: 'priceChange',
        data: {
          tokenId,
          price: Number(parsed.price ?? 0),
          size: Number(parsed.size ?? 0),
          side: parsed.side === 'SELL' ? 'SELL' : 'BUY',
          bestBid: bid,
          bestAsk: ask,
          ts,
        },
      }
    }

    case 'last_trade_price': {
      return {
        type: 'lastTrade',
        data: {
          tokenId,
          price: Number(parsed.price ?? 0),
          size: Number(parsed.size ?? 0),
          side: parsed.side === 'SELL' ? 'SELL' : 'BUY',
          ts,
        },
      }
    }

    case 'tick_size_change': {
      return {
        type: 'tickSizeChange',
        data: {
          tokenId,
          tickSize: Number(parsed.tick_size ?? parsed.tickSize ?? 0.01),
          ts,
        },
      }
    }

    // best_bid_ask fires when custom_feature_enabled: true
    case 'best_bid_ask': {
      return {
        type: 'bestBidAsk',
        data: {
          tokenId,
          bid: Number(parsed.bid ?? parsed.best_bid ?? 0),
          ask: Number(parsed.ask ?? parsed.best_ask ?? 0),
          ts,
        },
      }
    }

    default:
      return { type: 'unknown' }
  }
}
