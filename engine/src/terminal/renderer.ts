import chalk from 'chalk'
import type { GlobalState, MarketSymbol, SymbolState } from '../types/market.js'

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
  if (s.priceDirection === 'up') return chalk.green('▲')
  if (s.priceDirection === 'down') return chalk.red('▼')
  return chalk.gray('─')
}

function fmtConnection(status: string): string {
  if (status === 'connected') return chalk.green('●')
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

// ─── Sections ────────────────────────────────────────────────────────────────

function renderHeader(state: GlobalState): string[] {
  const rtds = fmtConnection(state.connections.rtds)
  const clob = fmtConnection(state.connections.clob)
  const countdown = fmtCountdown(state.window.secondsRemaining)
  const wStart = windowLabel(state.window.windowTs)
  const wEnd = windowLabel(state.window.closeTs)

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
    const s = state.symbols[sym]
    const priceStr = fmtPrice(s.oraclePrice, sym)
    const ageMs = s.oraclePriceTs ? Date.now() - s.oraclePriceTs : Infinity
    const stale = ageMs > 60_000
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
    const side = w.side === 'BUY' ? chalk.green('BUY') : chalk.red('SELL')
    const size = chalk.bold(`$${(w.sizeUsd / 1000).toFixed(1)}k`)
    const wallet = chalk.gray(w.wallet.slice(0, 6) + '…' + w.wallet.slice(-4))
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

// ─── Main Render ──────────────────────────────────────────────────────────────

export function render(state: GlobalState): string {
  const sections = [
    ...renderHeader(state),
    '',
    ...renderPriceTable(state),
    ...renderWhales(state),
    ...renderFooter(state),
  ]
  return sections.join('\n')
}
