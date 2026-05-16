/**
 * Post-simulation analytics — produces ExecutionReport from a finished session.
 *
 * Attribution:
 *   - PnL by symbol, by outcome, by regime (using latest signal frame's regime)
 *   - Avg slippage in bps, fill counts, win/loss ratios
 *   - Configuration snapshot for reproducibility
 */
import { config } from '../config/index'
import { mkdirSync, createWriteStream } from 'fs'
import { join } from 'path'
import { log } from '../utils/logger'
import type { SimulationEngine } from '../sim/SimulationEngine'
import type { ExecutionReport, SimFill } from '../sim/types'
import type { SignalFrame, MarketRegime } from '../signals/types'
import type { MarketSymbol } from '../types/market'

export class ExecutionAnalytics {
  constructor(
    private readonly outputDir: string,
    private readonly sessionId: string,
  ) {
    // Directory is created lazily on first export — produce() alone has no IO.
  }

  private ensureDir(): void {
    mkdirSync(this.outputDir, { recursive: true })
  }

  produce(
    sim:           SimulationEngine,
    strategyName:  string,
    fromTs:        number,
    toTs:          number,
    regimeByTs:    (symbol: MarketSymbol, ts: number) => MarketRegime | undefined,
  ): ExecutionReport {
    const portfolio = sim.getPortfolio()
    const fills     = portfolio.getFills()
    const counts    = sim.getSummaryCounts()
    const snapshot  = portfolio.snapshot(false)

    // Position-by-position win/loss derived from fills isn't trivial here; use snapshot counters
    const pnlBySymbol:  Partial<Record<MarketSymbol, number>>  = {}
    const pnlByRegime:  Partial<Record<MarketRegime, number>>  = {}
    const pnlByOutcome = { up: 0, down: 0 }

    // Attribute realized fill-level PnL (entry vs exit) to source dimensions.
    // For Polymarket binary outcomes, we approximate by treating each fill as
    // either an open (BUY) or a close (SELL); settlement pnl is folded into the
    // global realized total, not per-fill.
    const avgSlip = fills.length > 0
      ? fills.reduce((s, f) => s + Math.abs(f.slippageBps), 0) / fills.length
      : 0

    // Realized PnL aggregation by symbol/outcome
    // Note: this is an approximation — settlement PnL is in the global total
    for (const fill of fills) {
      const contribution = fill.side === 'SELL' ? fill.size * fill.price : -fill.size * fill.price
      pnlBySymbol[fill.symbol] = (pnlBySymbol[fill.symbol] ?? 0) + contribution - fill.fee
      pnlByOutcome[fill.outcome] += contribution - fill.fee

      const reg = regimeByTs(fill.symbol, fill.ts)
      if (reg) pnlByRegime[reg] = (pnlByRegime[reg] ?? 0) + contribution - fill.fee
    }

    // Average hold time across all fills (entry → exit). Computed by pairing
    // each SELL fill with the BUY fill it closes.
    let holdMsSum = 0
    let holdCount = 0
    const openByKey = new Map<string, number>()  // symbol+outcome+windowTs → first BUY ts
    for (const fill of fills) {
      // We don't have windowTs on the fill directly — use approximate by symbol+outcome
      // (good enough for average since each window is independent)
      const k = `${fill.symbol}:${fill.outcome}`
      if (fill.side === 'BUY' && !openByKey.has(k)) {
        openByKey.set(k, fill.ts)
      } else if (fill.side === 'SELL') {
        const openTs = openByKey.get(k)
        if (openTs != null) {
          holdMsSum += fill.ts - openTs
          holdCount++
          openByKey.delete(k)
        }
      }
    }

    return {
      sessionId:       this.sessionId,
      strategyName,
      fromTs,
      toTs,
      durationSecs:    (toTs - fromTs) / 1000,
      startCash:       snapshot.startCash,
      endEquity:       snapshot.totalEquity,
      totalPnl:        snapshot.totalEquity - snapshot.startCash,
      totalFees:       snapshot.totalFees,
      avgSlippageBps:  avgSlip,
      maxDrawdown:     snapshot.drawdown,
      ordersSubmitted: counts.submitted,
      ordersFilled:    counts.filled,
      ordersCancelled: counts.cancelled,
      ordersRejected:  counts.rejected,
      fills:           fills.length,
      winners:         snapshot.winners,
      losers:          snapshot.losers,
      winRate:         snapshot.winRate,
      avgWinUsd:       0,   // would require per-position attribution; left for later iteration
      avgLossUsd:      0,
      pnlByRegime,
      pnlBySymbol,
      pnlByOutcome,
      avgHoldTimeMs:   holdCount > 0 ? holdMsSum / holdCount : 0,
      config: {
        startCash:              config.simStartingCash,
        decisionLatencyMs:      config.simDecisionLatencyMs,
        wsLatencyMs:            config.simWsLatencyMs,
        executionLatencyMs:     config.simExecutionLatencyMs,
        takerFeeBps:            config.simTakerFeeBps,
        maxPositionUsd:         config.simMaxPositionUsd,
        maxConcurrentPositions: config.simMaxConcurrentPositions,
        maxConsecutiveLosses:   config.simMaxConsecutiveLosses,
      },
    }
  }

  async exportFills(fills: readonly SimFill[]): Promise<string> {
    this.ensureDir()
    const path = join(this.outputDir, `${this.sessionId}_fills.csv`)
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(path)
      ws.on('error', reject)
      ws.on('finish', resolve)
      ws.write('ts,orderId,symbol,outcome,side,price,size,fee,slippageBps,spreadCostBps,depthCostBps\n')
      for (const f of fills) {
        ws.write([
          f.ts, f.orderId, f.symbol, f.outcome, f.side,
          f.price.toFixed(6), f.size.toFixed(4), f.fee.toFixed(4),
          f.slippageBps.toFixed(2), f.spreadCostBps.toFixed(2), f.depthCostBps.toFixed(2),
        ].join(',') + '\n')
      }
      ws.end()
    })
    log.info(`[ExecutionAnalytics] fills written: ${path}  (${fills.length} rows)`)
    return path
  }

  async exportReport(report: ExecutionReport): Promise<string> {
    this.ensureDir()
    const path = join(this.outputDir, `${this.sessionId}_execution.json`)
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(path)
      ws.on('error', reject)
      ws.on('finish', resolve)
      ws.write(JSON.stringify(report, null, 2) + '\n')
      ws.end()
    })
    log.info(`[ExecutionAnalytics] report written: ${path}`)
    return path
  }

  printSummary(report: ExecutionReport): void {
    log.info('=== Execution Report ===', {
      sessionId:    report.sessionId,
      strategy:     report.strategyName,
      durationMin:  (report.durationSecs / 60).toFixed(1),
      startCash:    `$${report.startCash.toFixed(2)}`,
      endEquity:    `$${report.endEquity.toFixed(2)}`,
      totalPnl:     `$${report.totalPnl.toFixed(2)}`,
      pnlPct:       `${((report.totalPnl / report.startCash) * 100).toFixed(2)}%`,
      maxDrawdown:  `${(report.maxDrawdown * 100).toFixed(2)}%`,
      avgSlippage:  `${report.avgSlippageBps.toFixed(1)} bps`,
      totalFees:    `$${report.totalFees.toFixed(2)}`,
    })

    log.info('Orders', {
      submitted: report.ordersSubmitted,
      filled:    report.ordersFilled,
      cancelled: report.ordersCancelled,
      rejected:  report.ordersRejected,
    })

    log.info('Trades', {
      winners:       report.winners,
      losers:        report.losers,
      winRate:       `${(report.winRate * 100).toFixed(1)}%`,
      avgHoldSecs:   (report.avgHoldTimeMs / 1000).toFixed(1),
    })

    if (Object.keys(report.pnlBySymbol).length > 0) {
      log.info('PnL by symbol:', Object.fromEntries(
        Object.entries(report.pnlBySymbol).map(([k, v]) => [k, `$${v!.toFixed(2)}`])
      ))
    }
    if (Object.keys(report.pnlByRegime).length > 0) {
      log.info('PnL by regime:', Object.fromEntries(
        Object.entries(report.pnlByRegime).map(([k, v]) => [k, `$${v!.toFixed(2)}`])
      ))
    }
  }
}
