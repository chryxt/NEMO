export type MarketSymbol = 'BTC' | 'ETH' | 'SOL'

export const SYMBOLS: MarketSymbol[] = ['BTC', 'ETH', 'SOL']

export const RTDS_CHAINLINK_SYMBOL: Record<MarketSymbol, string> = {
  BTC: 'btc/usd',
  ETH: 'eth/usd',
  SOL: 'sol/usd',
}

export const RTDS_BINANCE_SYMBOL: Record<MarketSymbol, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
}

export const SLUG_PREFIX: Record<MarketSymbol, string> = {
  BTC: 'btc-updown-5m',
  ETH: 'eth-updown-5m',
  SOL: 'sol-updown-5m',
}

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'dead'

export interface MarketWindow {
  windowTs: number       // Unix seconds: start of current 5-min window
  closeTs: number        // Unix seconds: end of current 5-min window
  secondsRemaining: number
}

export interface WhaleTrade {
  wallet: string
  side: 'BUY' | 'SELL'
  sizeUsd: number
  price: number          // Token price (probability, 0-1)
  symbol: MarketSymbol
  outcome: string        // "Up" or "Down"
  ts: number             // Unix seconds
}

export interface SymbolState {
  oraclePrice: number | null
  oraclePriceTs: number | null
  openPrice: number | null
  priceDirection: 'up' | 'down' | 'flat' | null
  bestBid: number | null        // Best bid on UP outcome token
  bestAsk: number | null        // Best ask on UP outcome token
  spread: number | null
  lastTradePrice: number | null
  orderflowDelta: number        // USD: cumulative buys - sells this window
  recentWhales: WhaleTrade[]
  tokenIds: {
    up: string | null
    down: string | null
  }
}

export interface GlobalState {
  connections: {
    rtds: ConnectionStatus
    clob: ConnectionStatus
  }
  window: MarketWindow
  symbols: Record<MarketSymbol, SymbolState>
  startedAt: number
}

export function makeEmptySymbolState(): SymbolState {
  return {
    oraclePrice: null,
    oraclePriceTs: null,
    openPrice: null,
    priceDirection: null,
    bestBid: null,
    bestAsk: null,
    spread: null,
    lastTradePrice: null,
    orderflowDelta: 0,
    recentWhales: [],
    tokenIds: { up: null, down: null },
  }
}

export function makeInitialState(): GlobalState {
  const now = Math.floor(Date.now() / 1000)
  const windowTs = now - (now % 300)
  return {
    connections: { rtds: 'connecting', clob: 'connecting' },
    window: {
      windowTs,
      closeTs: windowTs + 300,
      secondsRemaining: windowTs + 300 - now,
    },
    symbols: {
      BTC: makeEmptySymbolState(),
      ETH: makeEmptySymbolState(),
      SOL: makeEmptySymbolState(),
    },
    startedAt: now,
  }
}
