import type { MarketSymbol } from '../types/market'
import type { MarketRegime } from '../signals/types'

// ── Order primitives ──────────────────────────────────────────────────────────

export type OrderType  = 'MARKET' | 'LIMIT' | 'IOC' | 'FOK'
export type OrderSide  = 'BUY' | 'SELL'
export type Outcome    = 'up' | 'down'
export type OrderState =
  | 'PENDING'        // submitted, awaiting arrival
  | 'OPEN'           // arrived, resting on book (LIMIT only)
  | 'FILLED'         // fully filled
  | 'PARTIAL'        // partially filled and still open
  | 'CANCELLED'      // cancelled (by IOC remainder, expiry, or user)
  | 'EXPIRED'        // hit expiry timestamp
  | 'REJECTED'       // rejected by risk manager

// What a strategy submits — the engine fills in IDs, timestamps, state.
export interface OrderRequest {
  symbol:      MarketSymbol
  outcome:     Outcome
  side:        OrderSide
  type:        OrderType
  size:        number          // shares (Polymarket: 1 share = $1 payoff if outcome wins)
  limitPrice?: number          // required for LIMIT/IOC/FOK, ignored for MARKET
  expiryMs?:   number          // duration until expiry (relative to tsSubmit)
  reason:      string          // human-readable explanation for logging/audit
  strategyId:  string
}

export interface SimOrder {
  id:           string
  strategyId:   string
  symbol:       MarketSymbol
  outcome:      Outcome
  side:         OrderSide
  type:         OrderType
  size:         number
  limitPrice:   number | null
  state:        OrderState
  tsSubmit:     number
  tsArrival:    number         // tsSubmit + totalLatency
  tsFill:       number | null
  expiryMs:     number | null  // absolute expiry timestamp
  filledSize:   number
  avgFillPrice: number | null
  midAtSubmit:  number | null  // mid price when order was submitted (for slippage attribution)
  reason:       string
  windowTs:     number
  rejectReason: string | null
}

export interface SimFill {
  orderId:      string
  ts:           number
  symbol:       MarketSymbol
  outcome:      Outcome
  side:         OrderSide
  price:        number
  size:         number
  fee:          number
  slippageBps:  number          // (avgFillPrice - midAtSubmit) / midAtSubmit × 10000
  spreadCostBps:number          // (avgFillPrice - mid)         / mid       × 10000
  depthCostBps: number          // (avgFillPrice - bestQuote)   / bestQuote × 10000
}

// ── Position & portfolio ──────────────────────────────────────────────────────

export interface SimPosition {
  symbol:        MarketSymbol
  outcome:       Outcome
  windowTs:      number
  size:          number          // shares
  avgEntryPrice: number          // weighted by size
  realizedPnl:   number          // PnL realized via sells (not settlement)
  totalFees:     number
  openTs:        number          // first fill time
  lastMarkMs:    number
  lastMarkPrice: number          // last known mid price for unrealized
}

export interface PortfolioSnapshot {
  cash:                number
  startCash:           number
  positionsValue:      number
  totalEquity:         number     // cash + sum of position MTM values
  realizedPnl:         number
  unrealizedPnl:       number
  totalFees:           number
  totalSlippageBps:    number     // average slippage across all fills
  openPositions:       number
  closedTrades:        number     // winning + losing settled positions
  winners:             number
  losers:              number
  winRate:             number
  consecutiveLosses:   number
  peakEquity:          number
  drawdown:            number     // fraction (0..1) from peak
  killSwitchActive:    boolean
}

// ── Execution analytics ──────────────────────────────────────────────────────

export interface ExecutionReport {
  sessionId:      string
  strategyName:   string
  fromTs:         number
  toTs:           number
  durationSecs:   number

  // Portfolio summary
  startCash:      number
  endEquity:      number
  totalPnl:       number
  totalFees:      number
  avgSlippageBps: number
  maxDrawdown:    number

  // Trade stats
  ordersSubmitted: number
  ordersFilled:    number
  ordersCancelled: number
  ordersRejected:  number
  fills:           number
  winners:         number
  losers:          number
  winRate:         number
  avgWinUsd:       number
  avgLossUsd:      number

  // Attribution
  pnlByRegime:     Partial<Record<MarketRegime, number>>
  pnlBySymbol:     Partial<Record<MarketSymbol, number>>
  pnlByOutcome:    { up: number; down: number }
  avgHoldTimeMs:   number

  // Latency & risk config (for reproducibility)
  config: {
    startCash:           number
    decisionLatencyMs:   number
    wsLatencyMs:         number
    executionLatencyMs:  number
    takerFeeBps:         number
    maxPositionUsd:      number
    maxConcurrentPositions: number
    maxConsecutiveLosses: number
  }
}
