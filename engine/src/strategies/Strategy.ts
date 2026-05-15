/**
 * Strategy interface. Pure rule-based logic — no AI, no learning.
 *
 * A strategy observes signal frames and whale alerts and optionally
 * returns an OrderRequest. The SimulationEngine handles all execution
 * mechanics (latency, fills, risk).
 *
 * Strategies are stateless from the engine's perspective — they may
 * maintain internal state (e.g., last-trade time per symbol), but the
 * engine never directly observes it.
 */
import type { SignalFrame } from '../signals/types.js'
import type { WhaleAlertEvent } from '../types/events.js'
import type { Portfolio } from '../sim/Portfolio.js'
import type { OrderRequest } from '../sim/types.js'

export interface Strategy {
  readonly name: string

  /** Called on every signal.frame event. Return null to skip. */
  onSignal(frame: SignalFrame, portfolio: Portfolio, nowMs: number): OrderRequest | null

  /** Optional: called on every whale.alert event. */
  onWhaleAlert?(event: WhaleAlertEvent, portfolio: Portfolio, nowMs: number): OrderRequest | null
}
