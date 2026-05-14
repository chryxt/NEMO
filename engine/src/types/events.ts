import type { MarketSymbol, MarketWindow, GlobalState, WhaleTrade } from './market.js'

// ─── RTDS Events ─────────────────────────────────────────────────────────────

export interface OraclePriceEvent {
  symbol: MarketSymbol
  price: number
  ts: number          // Unix milliseconds from Chainlink
  source: 'chainlink' | 'binance'
}

export interface ActivityTradeEvent {
  conditionId: string
  eventSlug: string
  outcome: string
  outcomeIndex: number
  side: 'BUY' | 'SELL'
  sizeShares: number
  price: number
  wallet: string
  pseudonym: string | null
  ts: number
  txHash: string
}

// ─── CLOB Events ─────────────────────────────────────────────────────────────

export interface ClobBookEvent {
  tokenId: string
  bids: Array<{ price: number; size: number }>
  asks: Array<{ price: number; size: number }>
  ts: number
}

export interface ClobBestBidAskEvent {
  tokenId: string
  bid: number
  ask: number
  ts: number
}

export interface ClobPriceChangeEvent {
  tokenId: string
  price: number
  size: number
  side: 'BUY' | 'SELL'
  bestBid: number
  bestAsk: number
  ts: number
}

export interface ClobLastTradeEvent {
  tokenId: string
  price: number
  size: number
  side: 'BUY' | 'SELL'
  ts: number
}

export interface ClobTickSizeChangeEvent {
  tokenId: string
  tickSize: number
  ts: number
}

// ─── Market Clock Events ──────────────────────────────────────────────────────

export interface MarketTickEvent {
  window: MarketWindow
}

export interface MarketWindowOpenEvent {
  windowTs: number
  closeTs: number
  tokenIds: Record<MarketSymbol, { up: string | null; down: string | null }>
}

// ─── State Events ─────────────────────────────────────────────────────────────

export interface StateSnapshotEvent {
  state: GlobalState
}

export interface WhaleAlertEvent {
  trade: WhaleTrade
}

// ─── Connection Events ────────────────────────────────────────────────────────

export interface ConnectionEvent {
  service: 'rtds' | 'clob'
  status: 'connecting' | 'connected' | 'reconnecting' | 'dead'
  attempt?: number
}

// ─── Event Bus Map ────────────────────────────────────────────────────────────

export interface BusEvents {
  'oracle.price': OraclePriceEvent
  'trade.activity': ActivityTradeEvent
  'clob.book': ClobBookEvent
  'clob.bestBidAsk': ClobBestBidAskEvent
  'clob.priceChange': ClobPriceChangeEvent
  'clob.lastTrade': ClobLastTradeEvent
  'clob.tickSizeChange': ClobTickSizeChangeEvent
  'market.tick': MarketTickEvent
  'market.windowOpen': MarketWindowOpenEvent
  'state.snapshot': StateSnapshotEvent
  'whale.alert': WhaleAlertEvent
  'connection.change': ConnectionEvent
}
