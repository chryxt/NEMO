/**
 * Phase 9 real-execution types — gateway decisions, operator actions,
 * RPC health, fill verification.
 *
 * EVERY field that could conceivably contain a secret is replaced with
 * a redacted placeholder before serialization.
 */
import type { ShadowOrder } from '../shadow/types.js'
import type { MarketSymbol } from '../types/market.js'
import type { Outcome } from '../sim/types.js'

// ── Gateway decision — produced by RealExecutionGateway.evaluate() ───────────

export type GateStep =
  | 'execution-enabled'
  | 'execution-armed'
  | 'shadow-enabled'
  | 'live-paper-enabled'
  | 'wallet-initialized'
  | 'api-key-configured'
  | 'shadow-valid'
  | 'sandbox-ok'
  | 'per-order-cap'
  | 'daily-notional-cap'
  | 'open-positions'
  | 'strategy-lock'
  | 'operator-approved'
  | 'rpc-health'
  | 'halt-inactive'
  | 'feeds-healthy'
  | 'kill-switch-clear'

export interface GatewayDecision {
  ok:               boolean
  steps:            Record<GateStep, { ok: boolean; reason: string | null }>
  failedAt:         GateStep | null
  reason:           string | null
  shadowOrderId:    string
}

// ── Real execution order — what the gateway tries to submit ──────────────────

export interface ExecutionOrder {
  id:              string
  shadowOrderId:   string
  simOrderId:      string
  createdAtMs:     number
  symbol:          MarketSymbol
  outcome:         Outcome
  side:            'BUY' | 'SELL'
  tokenId:         string
  size:            number
  limitPrice:      number
  notionalUsd:     number
  signature:       string         // real EIP-712 signature (0x... 132 chars incl prefix)
  signatureType:   0 | 1 | 2
  expirationSec:   number
  nonce:           string
  // Submission artifacts
  submittedAtMs:   number | null
  remoteOrderId:   string | null
  txHashes:        string[]
  status:          'pending' | 'submitted' | 'confirmed' | 'rejected' | 'failed'
  failureReason:   string | null
}

// ── Execution fill (as observed via REST or websocket) ───────────────────────

export interface ExecutionFill {
  executionOrderId: string
  remoteOrderId:    string
  ts:               number
  price:            number
  size:             number
  feeUsd:           number
  txHash:           string | null
}

// ── Comparison: shadow expected vs real observed ────────────────────────────

export interface ExecutionDelta {
  executionOrderId:   string
  generatedAtMs:      number
  predictedPrice:     number
  realizedPrice:      number | null
  priceDeltaBps:      number | null
  predictedFeeUsd:    number
  realizedFeeUsd:     number | null
  feeDeltaUsd:        number | null
  predictedSlippageBps: number
  realizedSlippageBps:  number | null
  slippageDeltaBps:   number | null
  latencyMs:          number | null
}

// ── Operator action — every console command goes through here ───────────────

export interface OperatorAction {
  ts:        number
  operator:  string
  command:   string
  payload:   Record<string, unknown>
  result:    'accepted' | 'rejected'
  reason:    string | null
}

// ── RPC health ───────────────────────────────────────────────────────────────

export interface RpcHealth {
  generatedAtMs:      number
  ok:                 boolean
  reason:             string | null
  blockNumber:        bigint | null
  blockAgeSecs:       number | null
  gasPriceGwei:       number | null
  rpcLatencyMs:       number | null
  // Rolling stats
  p99LatencyMs:       number
  avgGasGwei:         number
  consecutiveFailures: number
}

// ── Daily notional tracker (persisted) ───────────────────────────────────────

export interface DailyNotionalState {
  dateUtc:         string
  spentUsd:        number
  ordersSubmitted: number
  ordersFilled:    number
  ordersRejected:  number
  lastUpdatedMs:   number
}

// ── Gateway snapshot exposed via LivePaperSnapshot.execution ─────────────────

export interface ExecutionGatewaySnapshot {
  // Activation
  enabled:           boolean
  armed:             boolean
  dryRun:            boolean

  // Wallet
  walletAddress:     string     // public address — never the secret
  signerMethod:      'env-key' | 'rpc-signer' | 'none'

  // Counters
  ordersConsidered:  number
  ordersSubmitted:   number
  ordersConfirmed:   number
  ordersRejected:    number
  ordersFailed:      number

  // Daily
  daily:             DailyNotionalState

  // Health
  rpc:               RpcHealth | null
  haltActive:        boolean
  haltReason:        string | null

  // Constraints
  maxNotionalUsd:    number
  maxDailyNotionalUsd: number
  maxOpenPositions:  number
  strategyLock:      string | null

  // Recent
  recentDecisions:   GatewayDecision[]  // last 10
  recentDeltas:      ExecutionDelta[]   // last 5
  journalEntries:    number
}
