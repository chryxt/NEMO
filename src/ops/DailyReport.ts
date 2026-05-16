/**
 * Daily report writer — produces markdown + json + csv summaries at UTC
 * rollover (or on shutdown for partial day).
 *
 * Output layout:
 *   <outputDir>/daily/daily-<YYYY-MM-DD>.json
 *   <outputDir>/daily/daily-<YYYY-MM-DD>.md
 *   <outputDir>/daily/daily-summary.csv     ← appended one row per day
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { join } from 'path'
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import type { DailyReport } from './types.js'

const SUMMARY_HEADER = [
  'date',
  'startEquity', 'endEquity', 'netPnlUsd',
  'closedTrades', 'winRate', 'sharpe', 'drawdown',
  'signalCount', 'avgConfidence',
  'driftAlerts', 'criticalDrift', 'structuralBreaks',
  'rtdsUptimePct', 'clobUptimePct', 'rtdsReconnects', 'clobReconnects',
  'avgEventLagMs', 'p99EventLagMs', 'avgHeapMb', 'peakHeapMb',
  'whaleCount', 'whaleTotalUsd',
  'killSwitchActive',
].join(',')

export class DailyReportWriter {
  private writes = 0
  constructor(private readonly outputDir: string) {}

  write(report: DailyReport): { jsonPath: string; mdPath: string } {
    const dir = join(this.outputDir, 'daily')
    mkdirSync(dir, { recursive: true })

    const jsonPath = join(dir, `daily-${report.dateUtc}.json`)
    const mdPath   = join(dir, `daily-${report.dateUtc}.md`)
    const csvPath  = join(dir, 'daily-summary.csv')

    writeFileSync(jsonPath, JSON.stringify(report, null, 2))
    writeFileSync(mdPath,   renderMarkdown(report))

    if (!existsSync(csvPath)) appendFileSync(csvPath, SUMMARY_HEADER + '\n')
    appendFileSync(csvPath, renderCsvRow(report) + '\n')

    bus.emit('ops.dailyReport', { dateUtc: report.dateUtc, path: jsonPath })
    log.info(`[DailyReport] wrote ${jsonPath} / ${mdPath}`)
    this.writes++
    return { jsonPath, mdPath }
  }

  getWriteCount(): number { return this.writes }
}

function renderMarkdown(r: DailyReport): string {
  const lines: string[] = []
  lines.push(`# Daily Operations Report — ${r.dateUtc}`)
  lines.push('')
  lines.push(`Generated: ${new Date(r.generatedAtMs).toISOString()}`)
  lines.push(`Session window: ${new Date(r.sessionStartMs).toISOString()} → ${new Date(r.sessionEndMs).toISOString()}`)
  lines.push('')

  lines.push('## Edge')
  lines.push('')
  lines.push(`| Metric            | Value |`)
  lines.push(`| ----------------- | ----- |`)
  lines.push(`| Net PnL (USD)     | ${r.edge.netPnlUsd.toFixed(2)} |`)
  lines.push(`| Closed trades     | ${r.edge.closedTrades} |`)
  lines.push(`| Win rate          | ${(r.edge.winRate * 100).toFixed(1)}% |`)
  lines.push(`| Daily Sharpe      | ${r.edge.sharpe.toFixed(2)} |`)
  lines.push(`| Max drawdown      | ${(r.edge.drawdown * 100).toFixed(2)}% |`)
  lines.push('')

  lines.push('## Portfolio')
  lines.push('')
  lines.push(`| Metric         | Value |`)
  lines.push(`| -------------- | ----- |`)
  lines.push(`| Equity         | $${r.portfolio.totalEquity.toFixed(2)} |`)
  lines.push(`| Cash           | $${r.portfolio.cash.toFixed(2)} |`)
  lines.push(`| Realized PnL   | $${r.portfolio.realizedPnl.toFixed(2)} |`)
  lines.push(`| Unrealized PnL | $${r.portfolio.unrealizedPnl.toFixed(2)} |`)
  lines.push(`| Total fees     | $${r.portfolio.totalFees.toFixed(2)} |`)
  lines.push(`| Open positions | ${r.portfolio.openPositions} |`)
  lines.push(`| Kill switch    | ${r.portfolio.killSwitchActive ? 'ACTIVE' : 'OK'} |`)
  lines.push('')

  lines.push('## Signals')
  lines.push('')
  lines.push(`| Metric          | Value |`)
  lines.push(`| --------------- | ----- |`)
  lines.push(`| Count           | ${r.signals.count} |`)
  lines.push(`| Avg confidence  | ${r.signals.avgConfidence.toFixed(3)} |`)
  lines.push(`| Avg compute µs  | ${r.signals.avgComputeUs.toFixed(1)} |`)
  lines.push('')
  if (Object.keys(r.signals.regimeMix).length > 0) {
    lines.push('Regime mix:')
    for (const [k, v] of Object.entries(r.signals.regimeMix)) {
      lines.push(`  - ${k}: ${v}`)
    }
    lines.push('')
  }

  lines.push('## Drift')
  lines.push('')
  lines.push(`| Metric            | Value |`)
  lines.push(`| ----------------- | ----- |`)
  lines.push(`| Total alerts      | ${r.drift.alertCount} |`)
  lines.push(`| Critical alerts   | ${r.drift.criticalCount} |`)
  lines.push(`| Structural breaks | ${r.drift.structuralBreaks} |`)
  lines.push('')

  lines.push('## Reliability')
  lines.push('')
  lines.push(`| Metric             | Value |`)
  lines.push(`| ------------------ | ----- |`)
  lines.push(`| Uptime             | ${r.reliability.uptimeSecs}s |`)
  lines.push(`| RTDS uptime %      | ${(r.reliability.rtdsUptimePct * 100).toFixed(2)}% |`)
  lines.push(`| CLOB uptime %      | ${(r.reliability.clobUptimePct * 100).toFixed(2)}% |`)
  lines.push(`| RTDS reconnects    | ${r.reliability.rtdsReconnects} |`)
  lines.push(`| CLOB reconnects    | ${r.reliability.clobReconnects} |`)
  lines.push(`| Stale-feed warns   | ${r.reliability.staleFeedIncidents} |`)
  lines.push(`| Degraded episodes  | ${r.reliability.degradedEpisodes} |`)
  lines.push(`| Event lag avg ms   | ${r.reliability.avgEventLagMs.toFixed(1)} |`)
  lines.push(`| Event lag p99 ms   | ${r.reliability.p99EventLagMs.toFixed(1)} |`)
  lines.push(`| Heap avg MB        | ${r.reliability.avgHeapMb.toFixed(1)} |`)
  lines.push(`| Heap peak MB       | ${r.reliability.peakHeapMb.toFixed(1)} |`)
  lines.push(`| Heap growth MB/h   | ${r.reliability.memoryGrowthRatePerHr.toFixed(2)} |`)
  lines.push(`| Disk free MB       | ${r.reliability.diskFreeMb ?? 'n/a'} |`)
  lines.push('')

  lines.push('## Safety')
  lines.push('')
  for (const [k, v] of Object.entries(r.safety)) {
    lines.push(`- ${k}: ${JSON.stringify(v)}`)
  }
  lines.push('')

  lines.push('## Whales')
  lines.push('')
  lines.push(`Count: ${r.whales.count}   Total USD: $${r.whales.totalUsd.toFixed(0)}`)
  lines.push('')

  return lines.join('\n')
}

function renderCsvRow(r: DailyReport): string {
  return [
    r.dateUtc,
    r.portfolio.startCash.toFixed(2),
    r.portfolio.totalEquity.toFixed(2),
    r.edge.netPnlUsd.toFixed(2),
    r.edge.closedTrades,
    r.edge.winRate.toFixed(4),
    r.edge.sharpe.toFixed(4),
    r.edge.drawdown.toFixed(4),
    r.signals.count,
    r.signals.avgConfidence.toFixed(4),
    r.drift.alertCount,
    r.drift.criticalCount,
    r.drift.structuralBreaks,
    r.reliability.rtdsUptimePct.toFixed(4),
    r.reliability.clobUptimePct.toFixed(4),
    r.reliability.rtdsReconnects,
    r.reliability.clobReconnects,
    r.reliability.avgEventLagMs.toFixed(2),
    r.reliability.p99EventLagMs.toFixed(2),
    r.reliability.avgHeapMb.toFixed(2),
    r.reliability.peakHeapMb.toFixed(2),
    r.whales.count,
    r.whales.totalUsd.toFixed(0),
    r.portfolio.killSwitchActive ? '1' : '0',
  ].join(',')
}
