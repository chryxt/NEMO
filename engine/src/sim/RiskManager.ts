/**
 * Risk constraints enforced before order submission. All checks are
 * deterministic and stateless (read-only against Portfolio).
 *
 * Kill switch is one-way per session: triggered by max consecutive losses,
 * never auto-reset.
 */
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'
import type { Portfolio } from './Portfolio.js'
import type { OrderRequest } from './types.js'
import type { FeatureSnapshot } from '../signals/types.js'

export interface RiskDecision {
  ok:     boolean
  reason: string
}

const OK: RiskDecision = { ok: true, reason: '' }

export class RiskManager {
  private killSwitch = false
  private killReason = ''

  canSubmit(
    request:  OrderRequest,
    portfolio: Portfolio,
    nowMs:    number,
    features: FeatureSnapshot | null,
  ): RiskDecision {
    if (this.killSwitch) {
      return { ok: false, reason: 'kill-switch active (max consecutive losses)' }
    }

    // Cooldown after a losing trade
    const lastLoss = portfolio.getLastLossTs()
    if (lastLoss != null && nowMs - lastLoss < config.simCooldownAfterLossMs) {
      return { ok: false, reason: 'cooldown after loss' }
    }

    // Position-size USD limit
    const estPrice = request.limitPrice ?? 0.5
    const positionUsd = request.size * estPrice
    if (positionUsd > config.simMaxPositionUsd) {
      return { ok: false, reason: `position size $${positionUsd.toFixed(0)} > limit $${config.simMaxPositionUsd}` }
    }

    // Concurrent open positions cap
    if (request.side === 'BUY' && portfolio.getOpenPositionCount() >= config.simMaxConcurrentPositions) {
      return { ok: false, reason: 'max concurrent positions reached' }
    }

    // Sufficient cash for buys
    if (request.side === 'BUY' && positionUsd > portfolio.getCash()) {
      return { ok: false, reason: `insufficient cash: need $${positionUsd.toFixed(0)}, have $${portfolio.getCash().toFixed(0)}` }
    }

    // Optional volatility & liquidity guards (active when features are available)
    if (features) {
      if (config.simVolatilityGuard > 0 && features.oracle.volatility30s != null
          && features.oracle.volatility30s > config.simVolatilityGuard) {
        return { ok: false, reason: `volatility guard: ${features.oracle.volatility30s.toExponential(2)} > ${config.simVolatilityGuard}` }
      }
      if (config.simLiquidityGuard > 0 && features.quotes.spread != null
          && features.quotes.spread > config.simLiquidityGuard) {
        return { ok: false, reason: `liquidity guard: spread ${features.quotes.spread} > ${config.simLiquidityGuard}` }
      }
    }

    return OK
  }

  // Called on every closed position to update kill-switch state.
  onPositionClosed(portfolio: Portfolio, ts: number): void {
    if (portfolio.getConsecutiveLosses() >= config.simMaxConsecutiveLosses) {
      if (!this.killSwitch) {
        this.killSwitch = true
        this.killReason = `${portfolio.getConsecutiveLosses()} consecutive losses`
        log.error(`[RiskManager] KILL-SWITCH activated: ${this.killReason} (ts=${ts})`)
      }
    }
  }

  // Externally trigger the kill-switch (Phase 6 multi-source). Idempotent.
  triggerKill(reason: string): void {
    if (!this.killSwitch) {
      this.killSwitch = true
      this.killReason = reason
      log.error(`[RiskManager] KILL-SWITCH triggered externally: ${reason}`)
    }
  }

  // Explicit one-way reset — never auto-resets.
  resetKill(): void {
    if (this.killSwitch) {
      this.killSwitch = false
      this.killReason = ''
      log.info('[RiskManager] kill-switch reset')
    }
  }

  isKillSwitchActive(): boolean { return this.killSwitch }
  getKillReason(): string { return this.killReason }
}
