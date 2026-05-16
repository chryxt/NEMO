/**
 * Long-horizon analytics — reads finalized daily JSON reports and produces
 * weekly + monthly roll-ups (markdown).
 *
 * Reads from <outputDir>/daily/, writes to <outputDir>/weekly/ and
 * <outputDir>/monthly/. Runs at week/month UTC rollover (and on shutdown
 * for partial periods).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { log } from '../utils/logger'
import type { DailyReport } from './types'

export class LongHorizonAnalytics {
  constructor(private readonly outputDir: string) {}

  // ── Weekly ──────────────────────────────────────────────────────────────────
  writeWeekly(weekTag: string, days: DailyReport[]): string | null {
    if (days.length === 0) return null
    const dir = join(this.outputDir, 'weekly')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `weekly-${weekTag}.md`)
    writeFileSync(path, renderPeriodMarkdown(`Week ${weekTag}`, days))
    log.info(`[LongHorizonAnalytics] wrote ${path}`)
    return path
  }

  // ── Monthly ─────────────────────────────────────────────────────────────────
  writeMonthly(monthTag: string, days: DailyReport[]): string | null {
    if (days.length === 0) return null
    const dir = join(this.outputDir, 'monthly')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `monthly-${monthTag}.md`)
    writeFileSync(path, renderPeriodMarkdown(`Month ${monthTag}`, days))
    log.info(`[LongHorizonAnalytics] wrote ${path}`)
    return path
  }

  // ── Convenience: load all daily reports from disk ────────────────────────────
  loadAllDailyReports(): DailyReport[] {
    const dir = join(this.outputDir, 'daily')
    try {
      const files = readdirSync(dir).filter(f => f.startsWith('daily-') && f.endsWith('.json'))
      const reports: DailyReport[] = []
      for (const f of files) {
        try {
          reports.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as DailyReport)
        } catch (err) {
          log.warn(`[LongHorizonAnalytics] failed to parse ${f}: ${(err as Error).message}`)
        }
      }
      return reports.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc))
    } catch {
      return []
    }
  }

  // Returns reports falling within a [YYYY-MM-DD, YYYY-MM-DD] inclusive range
  filterByDateRange(all: DailyReport[], from: string, to: string): DailyReport[] {
    return all.filter(r => r.dateUtc >= from && r.dateUtc <= to)
  }
}

// ─── Aggregation logic ────────────────────────────────────────────────────────

function renderPeriodMarkdown(title: string, days: DailyReport[]): string {
  const totalPnl = days.reduce((s, d) => s + d.edge.netPnlUsd, 0)
  const totalTrades = days.reduce((s, d) => s + d.edge.closedTrades, 0)
  const totalWinners = days.reduce((s, d) => s + Math.round(d.edge.winRate * d.edge.closedTrades), 0)
  const winRate = totalTrades > 0 ? totalWinners / totalTrades : 0
  const sharpes = days.map(d => d.edge.sharpe).filter(s => Number.isFinite(s))
  const meanSharpe = sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0
  const sharpeStd  = stddev(sharpes, meanSharpe)
  const maxDd      = days.reduce((m, d) => Math.max(m, d.edge.drawdown), 0)

  const totalDrift   = days.reduce((s, d) => s + d.drift.alertCount, 0)
  const criticalDrift = days.reduce((s, d) => s + d.drift.criticalCount, 0)
  const structural   = days.reduce((s, d) => s + d.drift.structuralBreaks, 0)

  const totalSignals = days.reduce((s, d) => s + d.signals.count, 0)
  const avgConf = days.length > 0
    ? days.reduce((s, d) => s + d.signals.avgConfidence, 0) / days.length
    : 0

  const avgRtdsUp = days.reduce((s, d) => s + d.reliability.rtdsUptimePct, 0) / Math.max(1, days.length)
  const avgClobUp = days.reduce((s, d) => s + d.reliability.clobUptimePct, 0) / Math.max(1, days.length)
  const reconnects = days.reduce((s, d) => s + d.reliability.rtdsReconnects + d.reliability.clobReconnects, 0)

  const lines: string[] = []
  lines.push(`# ${title} — Long-Horizon Analytics`)
  lines.push('')
  lines.push(`Days covered: ${days.length}    Range: ${days[0]!.dateUtc} → ${days[days.length - 1]!.dateUtc}`)
  lines.push('')
  lines.push('## Edge persistence')
  lines.push('')
  lines.push(`| Metric             | Value |`)
  lines.push(`| ------------------ | ----- |`)
  lines.push(`| Net PnL (USD)      | ${totalPnl.toFixed(2)} |`)
  lines.push(`| Closed trades      | ${totalTrades} |`)
  lines.push(`| Win rate           | ${(winRate * 100).toFixed(1)}% |`)
  lines.push(`| Mean daily Sharpe  | ${meanSharpe.toFixed(2)} |`)
  lines.push(`| Sharpe stddev      | ${sharpeStd.toFixed(2)} |`)
  lines.push(`| Max drawdown       | ${(maxDd * 100).toFixed(2)}% |`)
  lines.push('')
  lines.push('## Drift evolution')
  lines.push('')
  lines.push(`| Metric             | Value |`)
  lines.push(`| ------------------ | ----- |`)
  lines.push(`| Total drift alerts | ${totalDrift} |`)
  lines.push(`| Critical alerts    | ${criticalDrift} |`)
  lines.push(`| Structural breaks  | ${structural} |`)
  lines.push('')
  lines.push('## Signals')
  lines.push('')
  lines.push(`| Metric             | Value |`)
  lines.push(`| ------------------ | ----- |`)
  lines.push(`| Total signals      | ${totalSignals} |`)
  lines.push(`| Avg confidence     | ${avgConf.toFixed(3)} |`)
  lines.push('')
  lines.push('## Reliability')
  lines.push('')
  lines.push(`| Metric             | Value |`)
  lines.push(`| ------------------ | ----- |`)
  lines.push(`| RTDS avg uptime    | ${(avgRtdsUp * 100).toFixed(2)}% |`)
  lines.push(`| CLOB avg uptime    | ${(avgClobUp * 100).toFixed(2)}% |`)
  lines.push(`| Total reconnects   | ${reconnects} |`)
  lines.push('')
  lines.push('## Daily breakdown')
  lines.push('')
  lines.push(`| Date | PnL | Trades | WinRate | Sharpe | Drift | Reconnects |`)
  lines.push(`| ---- | --- | ------ | ------- | ------ | ----- | ---------- |`)
  for (const d of days) {
    lines.push(
      `| ${d.dateUtc} | ${d.edge.netPnlUsd.toFixed(2)} | ${d.edge.closedTrades} | ` +
      `${(d.edge.winRate * 100).toFixed(0)}% | ${d.edge.sharpe.toFixed(2)} | ` +
      `${d.drift.alertCount} | ${d.reliability.rtdsReconnects + d.reliability.clobReconnects} |`,
    )
  }
  lines.push('')

  return lines.join('\n')
}

function stddev(xs: number[], mean: number): number {
  if (xs.length < 2) return 0
  const v = xs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / xs.length
  return Math.sqrt(v)
}

// ─── Date helpers (used by OperationsEngine) ──────────────────────────────────

export function weekTag(date: Date): string {
  // ISO-8601 week number — year + week
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const diff = d.getTime() - firstThursday.getTime()
  const week = 1 + Math.round(diff / (7 * 86_400_000))
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function monthTag(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}
