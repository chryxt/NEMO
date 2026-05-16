/**
 * Execution constraints — hard caps enforced by the gateway, with persistent
 * daily notional tracking.
 *
 * Persisted at <outputDir>/daily-notional-<YYYY-MM-DD>.json so a process
 * restart cannot reset the daily counter.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { log } from '../utils/logger.js'
import type { DailyNotionalState } from './types.js'

export interface ConstraintConfig {
  maxNotionalUsd:      number
  maxDailyNotionalUsd: number
  maxOpenPositions:    number
  strategyLock:        string
}

export class ExecutionConstraints {
  private daily: DailyNotionalState
  private openOrders = 0
  private readonly outputDir: string

  constructor(outputDir: string, private readonly cfg: ConstraintConfig) {
    this.outputDir = outputDir
    mkdirSync(outputDir, { recursive: true })
    this.daily = this.load(dateUtc(Date.now()))
  }

  /** Pre-flight notional check for a candidate order. Returns reason or null. */
  checkNotional(orderNotionalUsd: number): string | null {
    this.rolloverIfNeeded()
    if (orderNotionalUsd > this.cfg.maxNotionalUsd) {
      return `per-order $${orderNotionalUsd.toFixed(2)} > cap $${this.cfg.maxNotionalUsd}`
    }
    if (this.daily.spentUsd + orderNotionalUsd > this.cfg.maxDailyNotionalUsd) {
      return `daily $${(this.daily.spentUsd + orderNotionalUsd).toFixed(2)} > cap $${this.cfg.maxDailyNotionalUsd}`
    }
    return null
  }

  checkOpenPositions(): string | null {
    if (this.openOrders >= this.cfg.maxOpenPositions) {
      return `open positions ${this.openOrders} >= cap ${this.cfg.maxOpenPositions}`
    }
    return null
  }

  checkStrategy(strategyId: string): string | null {
    if (!this.cfg.strategyLock || this.cfg.strategyLock.length === 0) {
      return `strategy lock not configured`
    }
    if (strategyId !== this.cfg.strategyLock) {
      return `strategy '${strategyId}' != locked '${this.cfg.strategyLock}'`
    }
    return null
  }

  recordSubmission(orderNotionalUsd: number): void {
    this.rolloverIfNeeded()
    this.daily.spentUsd        += orderNotionalUsd
    this.daily.ordersSubmitted += 1
    this.daily.lastUpdatedMs    = Date.now()
    this.openOrders            += 1
    this.persist()
  }

  recordReject(): void {
    this.rolloverIfNeeded()
    this.daily.ordersRejected += 1
    this.daily.lastUpdatedMs   = Date.now()
    this.persist()
  }

  recordFilled(): void {
    this.daily.ordersFilled += 1
    this.openOrders          = Math.max(0, this.openOrders - 1)
    this.daily.lastUpdatedMs = Date.now()
    this.persist()
  }

  recordFailed(): void {
    this.openOrders = Math.max(0, this.openOrders - 1)
    this.persist()
  }

  getState(): DailyNotionalState { return { ...this.daily } }
  getOpenPositions(): number     { return this.openOrders }

  // ── Internal ────────────────────────────────────────────────────────────────

  private rolloverIfNeeded(): void {
    const today = dateUtc(Date.now())
    if (today !== this.daily.dateUtc) {
      log.info(`[ExecutionConstraints] daily rollover ${this.daily.dateUtc} → ${today}`)
      this.daily = this.load(today)
    }
  }

  private load(dateStr: string): DailyNotionalState {
    const path = join(this.outputDir, `daily-notional-${dateStr}.json`)
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as DailyNotionalState
      } catch (err) {
        log.warn(`[ExecutionConstraints] failed to load ${path}: ${(err as Error).message}`)
      }
    }
    return {
      dateUtc:        dateStr,
      spentUsd:       0,
      ordersSubmitted:0,
      ordersFilled:   0,
      ordersRejected: 0,
      lastUpdatedMs:  Date.now(),
    }
  }

  private persist(): void {
    const path = join(this.outputDir, `daily-notional-${this.daily.dateUtc}.json`)
    try { writeFileSync(path, JSON.stringify(this.daily, null, 2)) }
    catch (err) { log.error(`[ExecutionConstraints] persist failed: ${(err as Error).message}`) }
  }
}

function dateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
