import type { OraclePriceEvent, ActivityTradeEvent } from '../../types/events.js'
import type { MarketSymbol } from '../../types/market.js'
import { RTDS_CHAINLINK_SYMBOL, RTDS_BINANCE_SYMBOL } from '../../types/market.js'

const CHAINLINK_REVERSE: Record<string, MarketSymbol> = Object.fromEntries(
  Object.entries(RTDS_CHAINLINK_SYMBOL).map(([sym, feed]) => [feed, sym as MarketSymbol])
)
const BINANCE_REVERSE: Record<string, MarketSymbol> = Object.fromEntries(
  Object.entries(RTDS_BINANCE_SYMBOL).map(([sym, ticker]) => [ticker.toLowerCase(), sym as MarketSymbol])
)

export interface NormalizedRtdsMessage {
  type: 'oracle_price' | 'trade_activity' | 'unknown'
  oraclePrice?: OraclePriceEvent
  tradeActivity?: ActivityTradeEvent
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeRtds(parsed: any): NormalizedRtdsMessage {
  const topic: string = parsed?.topic ?? ''
  const msgType: string = parsed?.type ?? ''
  const payload = parsed?.payload ?? parsed

  // Chainlink price update
  if (topic === 'crypto_prices_chainlink' && msgType === 'update') {
    const symbol = CHAINLINK_REVERSE[payload?.symbol?.toLowerCase()]
    if (!symbol) return { type: 'unknown' }
    return {
      type: 'oracle_price',
      oraclePrice: {
        symbol,
        price: Number(payload.value),
        ts: Number(payload.timestamp ?? parsed.timestamp),
        source: 'chainlink',
      },
    }
  }

  // Binance price update (secondary display source)
  if (topic === 'crypto_prices' && msgType === 'update') {
    const symbol = BINANCE_REVERSE[payload?.symbol?.toLowerCase()]
    if (!symbol) return { type: 'unknown' }
    return {
      type: 'oracle_price',
      oraclePrice: {
        symbol,
        price: Number(payload.value),
        ts: Number(payload.timestamp ?? parsed.timestamp),
        source: 'binance',
      },
    }
  }

  // Activity trades
  if (topic === 'activity' && (msgType === 'trades' || msgType === 'orders_matched')) {
    const d = payload
    if (!d?.conditionId) return { type: 'unknown' }
    return {
      type: 'trade_activity',
      tradeActivity: {
        conditionId: d.conditionId,
        eventSlug: d.eventSlug ?? d.slug ?? '',
        outcome: d.outcome ?? '',
        outcomeIndex: Number(d.outcomeIndex ?? 0),
        side: d.side === 'BUY' ? 'BUY' : 'SELL',
        sizeShares: Number(d.size ?? 0),
        price: Number(d.price ?? 0),
        wallet: d.proxyWallet ?? '',
        pseudonym: d.pseudonym ?? null,
        ts: Number(d.timestamp ?? Math.floor(Date.now() / 1000)),
        txHash: d.transactionHash ?? '',
      },
    }
  }

  return { type: 'unknown' }
}
