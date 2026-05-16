import { createHash } from 'crypto'
import type { GlobalState } from '../types/market'

// Canonical JSON serialization: sorted keys, no whitespace.
// Ensures identical state always produces identical bytes regardless of
// object property insertion order.
function canonical(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']'
  const keys = Object.keys(obj as Record<string, unknown>).sort()
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonical((obj as Record<string, unknown>)[k])}`)
  return '{' + pairs.join(',') + '}'
}

/**
 * Deterministic hash of the market-data subset of GlobalState.
 *
 * Intentionally excludes:
 *   - recentWhales: time-dependent; pruning uses nowSec which differs between
 *     live runs and replay runs that complete at different wall-clock times.
 *   - connections: runtime transport state, not market data.
 *   - startedAt: varies per process launch.
 *
 * Returns the first 16 hex characters of SHA-256 (64-bit prefix).
 */
export function hashState(state: GlobalState): string {
  const market = {
    windowTs: state.window.windowTs,
    symbols: Object.fromEntries(
      (['BTC', 'ETH', 'SOL'] as const).map((sym) => {
        const s = state.symbols[sym]
        return [sym, {
          oraclePrice:     s.oraclePrice,
          oraclePriceTs:   s.oraclePriceTs,
          openPrice:       s.openPrice,
          priceDirection:  s.priceDirection,
          bestBid:         s.bestBid,
          bestAsk:         s.bestAsk,
          spread:          s.spread,
          lastTradePrice:  s.lastTradePrice,
          orderflowDelta:  s.orderflowDelta,
          tokenIds:        s.tokenIds,
        }]
      })
    ),
  }

  return createHash('sha256')
    .update(canonical(market))
    .digest('hex')
    .slice(0, 16)
}
