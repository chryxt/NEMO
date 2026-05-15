function str(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

function num(key: string, fallback: number, min?: number): number {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!isFinite(n)) throw new Error(`Config: ${key} must be a number, got "${raw}"`)
  if (min !== undefined && n < min) throw new Error(`Config: ${key} must be >= ${min}, got ${n}`)
  return n
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

function logLevel(key: string): 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
  const raw = process.env[key] ?? 'info'
  const valid = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
  if (!(valid as readonly string[]).includes(raw)) {
    throw new Error(`Config: ${key} must be one of ${valid.join('|')}, got "${raw}"`)
  }
  return raw as (typeof valid)[number]
}

function buildConfig() {
  return {
    // WebSocket URLs
    rtdsUrl:    str('RTDS_URL',     'wss://ws-live-data.polymarket.com'),
    clobWsUrl:  str('CLOB_WS_URL',  'wss://ws-subscriptions-clob.polymarket.com/ws/market'),

    // REST API URLs
    gammaApiUrl: str('GAMMA_API_URL', 'https://gamma-api.polymarket.com'),
    dataApiUrl:  str('DATA_API_URL',  'https://data-api.polymarket.com'),
    clobApiUrl:  str('CLOB_API_URL',  'https://clob.polymarket.com'),

    // Thresholds
    whaleThresholdUsd:  num('WHALE_THRESHOLD',     10_000, 0),
    terminalRefreshMs:  num('TERMINAL_REFRESH_MS', 500,    100),

    // Logging
    logLevel: logLevel('LOG_LEVEL'),
    nodeEnv:  str('NODE_ENV', 'development') as 'development' | 'production',

    // Feed health thresholds (seconds)
    oracleStaleSecs:    num('ORACLE_STALE_SECS',    30, 1),
    orderbookStaleSecs: num('ORDERBOOK_STALE_SECS', 15, 1),

    // Replay / Recording
    recordEvents: bool('RECORD_EVENTS', false),
    replayFile:   process.env['REPLAY_FILE'] ?? null,
    replaySpeed:  num('REPLAY_SPEED', 1.0, 0),
  } as const
}

export type Config = ReturnType<typeof buildConfig>

export const config: Config = (() => {
  try {
    return buildConfig()
  } catch (err) {
    process.stderr.write(`Fatal config error: ${(err as Error).message}\n`)
    process.exit(1)
  }
})()
