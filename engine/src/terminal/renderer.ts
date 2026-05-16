import chalk from 'chalk'
import type { GlobalState, MarketSymbol, SymbolState } from '../types/market'
import type { EngineMetrics } from '../engines/MetricsEngine'
import type { FeedHealth, FeedStatus } from '../monitors/FeedHealthMonitor'
import type { LivePaperSnapshot } from '../live/types'

const W = 72  // terminal width

// ─── Primitives ───────────────────────────────────────────────────────────────

const line = (s: string) => s.padEnd(W)
const rule = () => chalk.gray('─'.repeat(W))
const divider = () => chalk.gray('┄'.repeat(W))

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length)
}

function rpad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : ' '.repeat(width - s.length) + s
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(v: number | null, sym: MarketSymbol): string {
  if (v === null) return chalk.gray('  ─────')
  const fmt = sym === 'SOL'
    ? v.toFixed(2)
    : v >= 10_000
    ? v.toFixed(2)
    : v.toFixed(3)
  return fmt
}

function fmtOdds(v: number | null): string {
  if (v === null) return chalk.gray('  ─  ')
  const pct = (v * 100).toFixed(1)
  const color = v >= 0.6 ? chalk.green : v <= 0.4 ? chalk.red : chalk.yellow
  return color(rpad(pct + '%', 6))
}

function fmtSpread(v: number | null): string {
  if (v === null) return chalk.gray('─')
  return chalk.gray((v * 100).toFixed(1) + 'c')
}

function fmtDelta(v: number): string {
  const abs = Math.abs(v)
  const formatted = abs >= 1000
    ? '+$' + (abs / 1000).toFixed(1) + 'k'
    : '+$' + abs.toFixed(0)
  const signed = v >= 0 ? formatted : formatted.replace('+', '-')
  return v >= 0 ? chalk.green(signed) : chalk.red(signed)
}

function fmtDirection(s: SymbolState): string {
  if (!s.priceDirection) return ' '
  if (s.priceDirection === 'up')   return chalk.green('▲')
  if (s.priceDirection === 'down') return chalk.red('▼')
  return chalk.gray('─')
}

function fmtConnection(status: string): string {
  if (status === 'connected')    return chalk.green('●')
  if (status === 'reconnecting') return chalk.yellow('◌')
  return chalk.red('✕')
}

function fmtCountdown(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  const str = `${m}:${s.toString().padStart(2, '0')}`
  if (sec <= 10) return chalk.red.bold(str)
  if (sec <= 30) return chalk.yellow(str)
  return chalk.cyan(str)
}

function fmtTs(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const h = d.getUTCHours().toString().padStart(2, '0')
  const m = d.getUTCMinutes().toString().padStart(2, '0')
  const s = d.getUTCSeconds().toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

function windowLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const h = d.getUTCHours().toString().padStart(2, '0')
  const m = d.getUTCMinutes().toString().padStart(2, '0')
  return `${h}:${m}`
}

function fmtRate(r: number): string {
  return r.toFixed(1) + '/s'
}

function fmtMb(mb: number): string {
  return mb.toFixed(1) + 'MB'
}

function fmtUptime(ms: number | null): string {
  if (ms === null) return chalk.gray('─')
  const secs = Math.floor((Date.now() - ms) / 1000)
  if (secs < 60)  return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

function fmtTotal(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function fmtFeedStatus(status: FeedStatus, ageSecs: number | null): string {
  const age = ageSecs !== null ? `${ageSecs.toFixed(0)}s` : '?'
  if (status === 'healthy') return chalk.green(`✓(${age})`)
  if (status === 'warning') return chalk.yellow(`⚠(${age})`)
  return chalk.red(`✕(${age})`)
}

// ─── Sections ────────────────────────────────────────────────────────────────

function renderHeader(state: GlobalState): string[] {
  const rtds     = fmtConnection(state.connections.rtds)
  const clob     = fmtConnection(state.connections.clob)
  const countdown = fmtCountdown(state.window.secondsRemaining)
  const wStart   = windowLabel(state.window.windowTs)
  const wEnd     = windowLabel(state.window.closeTs)

  return [
    rule(),
    line(
      chalk.bold.white('  POLYMARKET ENGINE') +
      '  ' + chalk.gray(`RTDS:${rtds} CLOB:${clob}`) +
      '  ' + chalk.gray(`WINDOW ${wStart}→${wEnd}`) +
      '  ' + chalk.bold(`[${countdown}]`)
    ),
    rule(),
  ]
}

function renderPriceTable(state: GlobalState): string[] {
  const header = chalk.gray(
    '  ' +
    pad('SYMBOL', 7) +
    pad('ORACLE PRICE', 16) +
    pad('DIR', 5) +
    pad('BID(UP%)', 10) +
    pad('ASK(UP%)', 10) +
    pad('SPREAD', 9) +
    pad('Δ FLOW', 12)
  )

  const rows = (['BTC', 'ETH', 'SOL'] as MarketSymbol[]).map((sym) => {
    const s      = state.symbols[sym]
    const priceStr = fmtPrice(s.oraclePrice, sym)
    const ageMs  = s.oraclePriceTs ? Date.now() - s.oraclePriceTs : Infinity
    const stale  = ageMs > 60_000
    const priceColored = stale ? chalk.yellow(priceStr) : chalk.white.bold(priceStr)

    return (
      '  ' +
      chalk.cyan(pad(sym, 7)) +
      pad(priceColored, 16) +
      pad(fmtDirection(s), 5) +
      pad(fmtOdds(s.bestBid), 10) +
      pad(fmtOdds(s.bestAsk), 10) +
      pad(fmtSpread(s.spread), 9) +
      fmtDelta(s.orderflowDelta)
    )
  })

  return [header, divider(), ...rows]
}

function renderWhales(state: GlobalState): string[] {
  const allWhales = (['BTC', 'ETH', 'SOL'] as MarketSymbol[])
    .flatMap((sym) => state.symbols[sym].recentWhales)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)

  if (allWhales.length === 0) {
    return [
      '',
      chalk.gray('  WHALE ACTIVITY (last 60s)'),
      divider(),
      chalk.gray('  No whale activity in current window'),
    ]
  }

  const header = [
    '',
    chalk.gray('  WHALE ACTIVITY (last 60s)'),
    divider(),
    chalk.gray('  ' + pad('TIME', 9) + pad('SYM', 5) + pad('SIDE', 6) + pad('USD SIZE', 12) + pad('OUTCOME', 8) + 'WALLET'),
  ]

  const rows = allWhales.map((w) => {
    const timeStr = fmtTs(w.ts * 1000)
    const side    = w.side === 'BUY' ? chalk.green('BUY') : chalk.red('SELL')
    const size    = chalk.bold(`$${(w.sizeUsd / 1000).toFixed(1)}k`)
    const wallet  = chalk.gray(w.wallet.slice(0, 6) + '…' + w.wallet.slice(-4))
    return (
      '  ' +
      chalk.gray(pad(timeStr, 9)) +
      chalk.cyan(pad(w.symbol, 5)) +
      pad(side, 6) +
      pad(size, 12) +
      chalk.white(pad(w.outcome, 8)) +
      wallet
    )
  })

  return [...header, ...rows]
}

function renderMetrics(metrics: EngineMetrics): string[] {
  const rateRow = (
    '  ' +
    chalk.gray('oracle ') + chalk.white(pad(fmtRate(metrics.oracleMsgRate), 8)) +
    chalk.gray('trades ') + chalk.white(pad(fmtRate(metrics.tradeMsgRate), 8)) +
    chalk.gray('clob ')   + chalk.white(pad(fmtRate(metrics.clobMsgRate), 8)) +
    chalk.gray('│ ') +
    chalk.gray('heap ')   + chalk.white(pad(fmtMb(metrics.heapUsedMb), 9)) +
    chalk.gray('rss ')    + chalk.white(fmtMb(metrics.rssMb))
  )

  const reconRow = (
    '  ' +
    chalk.gray('RTDS ') + fmtConnection(metrics.rtdsConnectedSinceMs !== null ? 'connected' : 'reconnecting') +
    ' ' + chalk.white(fmtUptime(metrics.rtdsConnectedSinceMs)) +
    '  ' +
    chalk.gray('CLOB ') + fmtConnection(metrics.clobConnectedSinceMs !== null ? 'connected' : 'reconnecting') +
    ' ' + chalk.white(fmtUptime(metrics.clobConnectedSinceMs)) +
    '  ' +
    chalk.gray('recon:') + chalk.white(`${metrics.rtdsReconnects}/${metrics.clobReconnects}`) +
    '  ' +
    chalk.gray('total: oracle ') + chalk.white(fmtTotal(metrics.totalOraclePrices)) +
    chalk.gray('  trades ') + chalk.white(fmtTotal(metrics.totalTrades)) +
    chalk.gray('  clob ') + chalk.white(fmtTotal(metrics.totalClobEvents))
  )

  return [
    '',
    chalk.gray('  SYSTEM METRICS'),
    divider(),
    rateRow,
    reconRow,
  ]
}

function renderHealth(health: FeedHealth): string[] {
  const oracle = (['BTC', 'ETH', 'SOL'] as MarketSymbol[])
    .map((sym) => chalk.cyan(sym) + ' ' + fmtFeedStatus(health.oracle[sym].status, health.oracle[sym].ageSecs))
    .join('  ')

  const clobStr = chalk.gray('CLOB ') + fmtFeedStatus(health.clob.status, health.clob.ageSecs)

  const degraded = health.degraded ? '  ' + chalk.red.bold('⚠ DEGRADED') : ''

  return [
    '',
    chalk.gray('  FEED HEALTH'),
    divider(),
    '  ' + oracle + '  │  ' + clobStr + degraded,
  ]
}

function renderFooter(state: GlobalState): string[] {
  const uptime = Math.floor(Date.now() / 1000) - state.startedAt
  const uptimeStr = uptime >= 60
    ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
    : `${uptime}s`
  return [
    '',
    rule(),
    chalk.gray(`  uptime: ${uptimeStr}  ·  ${new Date().toUTCString()}`),
    rule(),
  ]
}

// ─── Live Paper (Phase 6) ─────────────────────────────────────────────────────

function renderLivePaper(paper: LivePaperSnapshot): string[] {
  const p = paper.portfolio
  const h = paper.health
  const k = paper.killSwitch
  const d = paper.drift

  const pnl     = p.totalEquity - p.startCash
  const pnlPct  = p.startCash > 0 ? (pnl / p.startCash) * 100 : 0
  const pnlStr  = pnl >= 0 ? chalk.green(`+$${pnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(pnl).toFixed(2)}`)
  const pctStr  = pnl >= 0 ? chalk.green(`(+${pnlPct.toFixed(2)}%)`) : chalk.red(`(${pnlPct.toFixed(2)}%)`)
  const ddStr   = chalk.yellow(`${(p.drawdown * 100).toFixed(2)}%`)

  const statusStr = k.active
    ? chalk.red(`KILL-SWITCH (${k.triggeredBy ?? 'unknown'})`)
    : chalk.green('ACTIVE')

  const recentFillsLine = paper.recentFills.length > 0
    ? paper.recentFills.slice(-3).map(f =>
        `${f.symbol} ${f.outcome} ${f.side} @${f.price.toFixed(3)}`).join(' | ')
    : '(no fills yet)'

  const driftLine = d.hasBaseline
    ? (d.metrics
        .filter(m => m.severity !== 'info')
        .slice(0, 3)
        .map(m => `${m.metric} ${m.drift >= 0 ? '+' : ''}${(m.drift * 100).toFixed(0)}%${m.severity === 'critical' ? '!' : ''}`)
        .join(' ') || chalk.green('within baseline'))
    : chalk.gray('(no baseline)')

  const lines = [
    chalk.cyan('═══ LIVE PAPER ' + '═'.repeat(57)),
    `  Status: ${statusStr}${k.reason ? '  ' + chalk.gray(`(${k.reason.slice(0, 50)})`) : ''}`,
    `  Cash: $${p.cash.toFixed(2)}  Equity: $${p.totalEquity.toFixed(2)}  PnL: ${pnlStr} ${pctStr}  DD: ${ddStr}`,
    `  Open: ${p.openPositions}  Trades: ${p.winners}W/${p.losers}L (${(p.winRate * 100).toFixed(1)}%)  ` +
      `Signals/min: ${h.signalsPerMin.toFixed(1)}  Conf: ${h.avgConfidence.toFixed(2)}`,
    `  Latency p99: ${h.p99ComputeLatencyUs.toFixed(0)}µs  ` +
      `Flips: ${h.directionFlipsLast5Min}  ` +
      `RegimeTrans: ${h.regimeTransitionsLast5Min}  ` +
      `Drift: ${driftLine}`,
    `  Recent: ${recentFillsLine}`,
  ]
  if (paper.ops) {
    const o = paper.ops
    const e = o.edge.mediumWindow
    const r = o.reliability
    const s = o.safety
    const flags: string[] = []
    if (s.strategyDegraded)     flags.push(chalk.yellow('DEGRADED'))
    if (s.reconnectStormActive) flags.push(chalk.red('STORM'))
    if (s.memoryPressureActive) flags.push(chalk.red('MEM'))
    if (s.feedEscalationActive) flags.push(chalk.red('FEED-ESC'))
    if (s.diskPressureActive)   flags.push(chalk.yellow('DISK'))
    const flagStr = flags.length > 0 ? '  ' + flags.join(' ') : ''
    lines.push(chalk.cyan('─── ops ────────────────────────────────────────────────────────────────'))
    lines.push(
      `  Day: ${o.currentDateUtc}  Reports: ${o.reportsWritten}  ` +
      `DatasetRecs: ${o.datasetRecords}  Days: ${o.edge.dailyHistory.length}`,
    )
    lines.push(
      `  Sharpe 60m: ${e.rollingSharpe.toFixed(2)}  ` +
      `HitRate: ${(e.rollingHitRate * 100).toFixed(0)}%  ` +
      `HalfLife: ${o.edge.edgeHalfLifeHours != null ? o.edge.edgeHalfLifeHours.toFixed(1) + 'h' : 'n/a'}  ` +
      `Breaks: ${o.drift.structuralBreaks.length}`,
    )
    lines.push(
      `  Uptime RTDS/CLOB: ${(r.rtdsUptimePct * 100).toFixed(1)}%/${(r.clobUptimePct * 100).toFixed(1)}%  ` +
      `Reconn: ${r.rtdsReconnects}/${r.clobReconnects}  ` +
      `LagP99: ${r.p99EventLagMs.toFixed(0)}ms  ` +
      `Heap: ${r.avgHeapMb.toFixed(0)}MB${flagStr}`,
    )
  }
  if (paper.shadow) {
    const sh = paper.shadow
    const rd = sh.readiness
    const sg = sh.sandbox
    const sandboxFlags: string[] = []
    if (sg.globalHaltActive)         sandboxFlags.push(chalk.red('HALT'))
    if (!sg.walletEnabled)           sandboxFlags.push(chalk.gray('wallet:off'))
    if (sg.singleStrategyLock)       sandboxFlags.push(chalk.yellow(`lock:${sg.singleStrategyLock}`))
    sandboxFlags.push(chalk.gray(`cap:$${sg.maxNotionalUsd}`))
    sandboxFlags.push(chalk.red('NO-LIVE-EXEC'))
    lines.push(chalk.cyan('─── shadow ─────────────────────────────────────────────────────────────'))
    lines.push(
      `  Orders: ${sh.ordersGenerated} signed: ${sh.ordersSigned}  ` +
      `Pending: ${sh.approvalsPending}  Approved: ${sh.approvalsApproved}  Rejected: ${sh.approvalsRejected}`,
    )
    lines.push(
      `  Readiness: ${(rd.overallReadiness * 100).toFixed(0)}%  ` +
      `Realism: ${(rd.fillRealismScore * 100).toFixed(0)}%  ` +
      `OpStab: ${(rd.operationalStability * 100).toFixed(0)}%  ` +
      `LatStab: ${(rd.latencyStability * 100).toFixed(0)}%  ` +
      `RiskFlags: ${sh.operationalRisk.flagsLastHour}`,
    )
    lines.push(`  Audit: ${sh.auditEntries} entries  ${sandboxFlags.join(' ')}`)
    if (sh.execution) {
      const ex = sh.execution
      const armed = ex.enabled && ex.armed
      const live  = armed && !ex.dryRun
      const statusBadge =
        live                  ? chalk.red('LIVE-EXEC') :
        armed                 ? chalk.yellow('ARMED-DRY-RUN') :
        ex.enabled            ? chalk.gray('LOADED') :
                                 chalk.gray('disabled')
      const haltBadge = ex.haltActive ? chalk.red(`HALT(${ex.haltReason ?? ''})`.slice(0, 40)) : ''
      const rpcBadge  = ex.rpc?.ok === false ? chalk.red(`RPC:${ex.rpc.reason}`.slice(0, 30)) : ''
      lines.push(chalk.cyan('─── execution ──────────────────────────────────────────────────────────'))
      lines.push(
        `  Gateway: ${statusBadge}  signer=${ex.signerMethod}  wallet=${ex.walletAddress.slice(0, 10)}…  ${haltBadge} ${rpcBadge}`,
      )
      lines.push(
        `  Daily: $${ex.daily.spentUsd.toFixed(2)}/$${ex.maxDailyNotionalUsd}  ` +
        `cap=$${ex.maxNotionalUsd}  maxOpen=${ex.maxOpenPositions}  ` +
        `lock=${ex.strategyLock ?? '(none)'}  ` +
        `subm=${ex.ordersSubmitted} conf=${ex.ordersConfirmed} rej=${ex.ordersRejected} fail=${ex.ordersFailed}`,
      )
    }
  }
  lines.push('')
  return lines
}

// ─── Main Render ──────────────────────────────────────────────────────────────

export function render(
  state:   GlobalState,
  metrics: EngineMetrics,
  health:  FeedHealth,
  paper?:  LivePaperSnapshot,
): string {
  const sections = [
    ...renderHeader(state),
    '',
    ...renderPriceTable(state),
    ...renderWhales(state),
    ...(paper ? renderLivePaper(paper) : []),
    ...renderMetrics(metrics),
    ...renderHealth(health),
    ...renderFooter(state),
  ]
  return sections.join('\n')
}
