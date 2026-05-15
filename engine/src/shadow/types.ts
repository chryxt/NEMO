/**
 * Phase 8 shadow-execution types — order intent, signing, approval queue,
 * audit chain, readiness scoring, operational risk.
 *
 * All types are dry-run by design. There is no field that authorizes,
 * authenticates, or transports a real order to any venue.
 */
import type { MarketSymbol } from '../types/market.js'
import type { OrderSide, Outcome } from '../sim/types.js'

// ── Polymarket-compatible Order struct (dry-run shape only) ──────────────────
//
// Mirrors Polymarket CTF Exchange EIP-712 Order primary type so that the
// shadow path produces canonical structures. Field types kept as `string`
// for uint256 to avoid bigint serialization surprises.
export interface PolymarketOrderStruct {
  salt:           string   // hex bytes32
  maker:          string   // address (operator wallet — currently disabled)
  signer:         string   // address (same as maker for EOA)
  taker:          string   // address (zero address = open)
  tokenId:        string   // uint256
  makerAmount:    string   // uint256 (USDC units, 6 decimals)
  takerAmount:    string   // uint256 (CTF shares units, 6 decimals)
  expiration:     string   // unix seconds
  nonce:          string   // uint256
  feeRateBps:     string   // uint256 (basis points)
  side:           0 | 1    // 0=BUY, 1=SELL
  signatureType:  0 | 1 | 2  // 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE
}

// ── Shadow order — intent + canonical structure + dry-run signature ──────────

export interface ShadowOrder {
  id:               string                   // local UID
  createdAtMs:      number                   // wall clock when shadow built
  simOrderId:       string                   // upstream SimOrder.id reference
  symbol:           MarketSymbol
  outcome:          Outcome
  side:             OrderSide
  tokenId:          string
  size:             number                   // shares
  limitPrice:       number                   // 0..1
  notionalUsd:      number                   // size × price
  predictedFill: {
    price:          number
    slippageBps:    number
    spreadBps:      number
    bookDepthAtMid: number | null
    marketImpactEstimate: number             // size / depth, 0..1+
  }
  feePreviewUsd:    number
  expirationMs:     number                   // absolute
  struct:           PolymarketOrderStruct
  signature:        ShadowSignature
}

// ── Dry-run signature container ──────────────────────────────────────────────

export interface ShadowSignature {
  mode:      'dry-run'                       // hard-coded — no other mode exists yet
  algorithm: 'SHA256-DRYRUN'                 // labeled non-real
  value:     string                          // 'DRYRUN-0x...'
  hash:      string                          // canonical hash of the order struct
  signedAt:  number
}

// ── Approval workflow ────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface ApprovalRequest {
  id:            string                      // matches ShadowOrder.id
  status:        ApprovalStatus
  createdAtMs:   number
  expiresAtMs:   number
  decidedAtMs:   number | null
  decidedBy:     string | null               // operator label
  reason:        string | null
  order:         ShadowOrder
}

export interface ApprovalDecision {
  id:        string
  approve:   boolean
  operator:  string
  reason:    string
}

// ── Execution comparator output ──────────────────────────────────────────────

export interface ExecutionComparison {
  shadowOrderId:      string
  generatedAtMs:      number
  predictedPrice:     number
  observedMidAfter:   number | null
  observedBestAfter:  number | null
  priceErrorBps:      number | null
  realismScore:       number                 // 0..1
  shadowToFillLatencyMs: number | null      // shadow.submitTs to sim fill.ts
}

// ── Execution readiness composite ────────────────────────────────────────────

export interface ExecutionReadinessReport {
  generatedAtMs:           number
  executionConfidence:     number            // 0..1
  fillRealismScore:        number            // mean of recent comparisons
  operationalStability:    number            // 1 - normalized risk-flag count
  latencyStability:        number            // 1 - normalized std/mean of shadow latencies
  marketImpactScore:       number            // 1 - mean impact estimate (lower impact = higher score)
  overallReadiness:        number            // weighted aggregate
  components: {
    samples:               number
    avgRealism:            number
    realismStd:            number
    avgShadowLatencyMs:    number
    stdShadowLatencyMs:    number
    activeRiskFlags:       number
  }
}

// ── Operational risk ─────────────────────────────────────────────────────────

export type RiskFlagKind =
  | 'signing-failure'
  | 'nonce-desync'
  | 'rpc-instability'
  | 'gas-anomaly'
  | 'exchange-api-degraded'
  | 'websocket-divergence'

export interface RiskFlag {
  kind:    RiskFlagKind
  ts:      number
  detail:  string
}

export interface OperationalRiskStatus {
  flagsLastHour:   number
  byKind:          Partial<Record<RiskFlagKind, number>>
  recent:          RiskFlag[]   // last 20
  signingFailures: number
  nonceMismatches: number
}

// ── Audit log ────────────────────────────────────────────────────────────────

export interface AuditEntry {
  seq:        number
  ts:         number
  type:       string                         // 'shadow.created' | 'shadow.signed' | etc.
  actor:      string                         // 'engine' | operator label
  payload:    unknown
  prevHash:   string
  hash:       string
}

// ── Sandbox guards ───────────────────────────────────────────────────────────

export interface SandboxGuardStatus {
  globalHaltActive:     boolean
  haltReason:           string | null
  maxNotionalUsd:       number
  singleStrategyLock:   string | null        // strategy name allowed; null = any
  walletEnabled:        boolean
  approvalsRequired:    boolean
  realSubmissionAllowed:boolean              // ALWAYS false in this phase
}

// ── Snapshot exposed via LivePaperSnapshot.shadow ─────────────────────────────

export interface ShadowSnapshot {
  enabled:               boolean
  ordersGenerated:       number
  ordersSigned:          number
  approvalsPending:      number
  approvalsApproved:     number
  approvalsRejected:     number
  readiness:             ExecutionReadinessReport
  operationalRisk:       OperationalRiskStatus
  sandbox:               SandboxGuardStatus
  auditEntries:          number
  recent: {
    pending:             ApprovalRequest[]   // last 3
    approved:            ApprovalRequest[]   // last 3
    comparisons:         ExecutionComparison[]  // last 5
  }
}
