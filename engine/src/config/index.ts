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

    // Replay verification — set EXPECTED_STATE_HASH to the hash from a prior run
    expectedStateHash: process.env['EXPECTED_STATE_HASH'] ?? null,

    // Memory pressure warning threshold (MB)
    memoryWarnMb: num('MEMORY_WARN_MB', 200, 50),

    // ── Database ─────────────────────────────────────────────────────────────
    dbUrl:     str('DATABASE_URL', ''),
    dbPoolMin: num('DB_POOL_MIN', 2, 1),
    dbPoolMax: num('DB_POOL_MAX', 10, 1),

    // ── Persistence Engine ────────────────────────────────────────────────────
    persistenceEnabled:   bool('PERSISTENCE_ENABLED',   false),
    persistenceBatchSize: num('PERSISTENCE_BATCH_SIZE',  200, 1),
    persistenceFlushMs:   num('PERSISTENCE_FLUSH_MS',    500, 100),
    persistenceQueueMax:  num('PERSISTENCE_QUEUE_MAX',  5_000, 100),
    persistenceQueueWarn: num('PERSISTENCE_QUEUE_WARN', 1_000, 100),

    // ── Event Journal (requires persistenceEnabled) ───────────────────────────
    journalEnabled: bool('JOURNAL_ENABLED', false),

    // ── DB Replay ─────────────────────────────────────────────────────────────
    dbReplayFrom: process.env['DB_REPLAY_FROM'] ?? null,   // ISO timestamp
    dbReplayTo:   process.env['DB_REPLAY_TO']   ?? null,   // ISO timestamp (optional)

    // ── Signal Engine ─────────────────────────────────────────────────────────
    signalsEnabled: bool('SIGNALS_ENABLED', false),

    // ── Research Mode ─────────────────────────────────────────────────────────
    // Set RESEARCH_MODE=true with REPLAY_FILE or DB_REPLAY_FROM to run analysis
    researchMode:      bool('RESEARCH_MODE', false),
    researchOutputDir: str('RESEARCH_OUTPUT_DIR', './research-output'),

    // ── Simulation / Paper Execution ──────────────────────────────────────────
    // Set SIMULATION_MODE=true with REPLAY_FILE or DB_REPLAY_FROM
    simulationMode:    bool('SIMULATION_MODE', false),
    simOutputDir:      str('SIM_OUTPUT_DIR',  './sim-output'),
    simStrategy:       str('SIM_STRATEGY',    'composite'),  // 'composite' | 'whale' | 'composite,whale'

    // Starting capital
    simStartingCash:   num('SIM_STARTING_CASH', 10_000, 100),

    // Latency model (ms) — additive
    simDecisionLatencyMs:  num('SIM_DECISION_LATENCY_MS',  5, 0),
    simWsLatencyMs:        num('SIM_WS_LATENCY_MS',       50, 0),
    simExecutionLatencyMs: num('SIM_EXECUTION_LATENCY_MS',10, 0),

    // Fees (basis points)
    simTakerFeeBps: num('SIM_TAKER_FEE_BPS', 20, 0),
    simMakerFeeBps: num('SIM_MAKER_FEE_BPS',  0, 0),

    // Risk constraints
    simMaxPositionUsd:        num('SIM_MAX_POSITION_USD',         1_000, 1),
    simMaxConcurrentPositions:num('SIM_MAX_CONCURRENT_POSITIONS', 5, 1),
    simMaxConsecutiveLosses:  num('SIM_MAX_CONSECUTIVE_LOSSES',   5, 1),
    simCooldownAfterLossMs:   num('SIM_COOLDOWN_AFTER_LOSS_MS',   30_000, 0),

    // Optional guards (0 = disabled)
    simVolatilityGuard: num('SIM_VOLATILITY_GUARD', 0, 0),
    simLiquidityGuard:  num('SIM_LIQUIDITY_GUARD',  0, 0),

    // Strategy thresholds
    simMinConfidence:   num('SIM_MIN_CONFIDENCE',   0.60, 0),
    simMinWhaleSizeUsd: num('SIM_MIN_WHALE_SIZE_USD', 10_000, 0),

    // ── Validation (Phase 5) ─────────────────────────────────────────────────
    validationMode:        bool('VALIDATION_MODE', false),
    validationSuite:       str('VALIDATION_SUITE', 'full'),  // sweep|walk-forward|monte-carlo|scenarios|compare|full
    validationOutputDir:   str('VALIDATION_OUTPUT_DIR', './validation-output'),

    // Walk-forward
    validationWfWindowMs:      num('VALIDATION_WF_WINDOW_MS',     30 * 60_000, 60_000),  // 30 min
    validationWfTrainFraction: num('VALIDATION_WF_TRAIN_FRACTION', 0.7, 0.1),
    validationWfStepMs:        num('VALIDATION_WF_STEP_MS',       15 * 60_000, 60_000),  // 15 min

    // Monte Carlo
    validationMcRuns:                num('VALIDATION_MC_RUNS',                  50, 1),
    validationMcBaseSeed:            num('VALIDATION_MC_BASE_SEED',             42, 0),
    validationMcLatencyJitterMs:     num('VALIDATION_MC_LATENCY_JITTER_MS',     10, 0),
    validationMcWhaleShiftMs:        num('VALIDATION_MC_WHALE_SHIFT_MS',     2_000, 0),
    validationMcSpreadStd:           num('VALIDATION_MC_SPREAD_STD',           0.1, 0),
    validationMcSlippageExtraBps:    num('VALIDATION_MC_SLIPPAGE_EXTRA_BPS',     5, 0),

    // ── Live Paper Trading (Phase 6) ─────────────────────────────────────────
    // Set LIVE_PAPER_ENABLED=true to run the simulation engine against live data.
    // No real trades placed. Includes drift detection, health monitoring, and
    // multi-source kill-switch.
    livePaperEnabled:           bool('LIVE_PAPER_ENABLED', false),

    // Drift baseline (JSON file path — see Phase 6 README)
    liveBaselineFile:           str('LIVE_BASELINE_FILE', ''),

    // Session recording (forensic JSONL with snapshots)
    liveSessionRecord:          bool('LIVE_SESSION_RECORD', true),
    liveSessionOutputDir:       str('LIVE_SESSION_OUTPUT_DIR', './live-sessions'),

    // Kill-switch thresholds (0 = disabled)
    liveKillSwitchVolatility:   num('LIVE_KILL_SWITCH_VOLATILITY',   0.001, 0),
    liveKillSwitchLatencyMs:    num('LIVE_KILL_SWITCH_LATENCY_MS',   5_000, 0),
    liveKillSwitchFile:         str('LIVE_KILL_SWITCH_FILE',         ''),

    // ── Operations Engine (Phase 7 — Long-Run Operations) ───────────────────
    // Requires LIVE_PAPER_ENABLED=true. Adds long-run observability:
    // edge persistence, drift evolution, reliability monitoring, daily reports,
    // dataset curation, operational safety. NO real execution, NO ML.
    opsEnabled:                bool('OPS_ENABLED', false),
    opsOutputDir:              str('OPS_OUTPUT_DIR', './ops-output'),
    opsDatasetEnabled:         bool('OPS_DATASET_ENABLED', true),
    opsReliabilitySampleMs:    num('OPS_RELIABILITY_SAMPLE_MS', 30_000, 1_000),
    opsEquitySampleMs:         num('OPS_EQUITY_SAMPLE_MS', 60_000, 5_000),

    // Health degradation thresholds
    opsDegradeSharpe:          num('OPS_DEGRADE_SHARPE', 0.0, -10),
    opsAutoKillOnDegrade:      bool('OPS_AUTOKILL_ON_DEGRADE', false),

    // Reconnect storm guard
    opsReconnectStormCount:    num('OPS_RECONNECT_STORM_COUNT', 5, 1),
    opsReconnectStormWindowMs: num('OPS_RECONNECT_STORM_WINDOW_MS', 60_000, 1_000),

    // Memory / feed / disk pressure (0 = disabled)
    opsMemoryKillMb:           num('OPS_MEMORY_KILL_MB', 0, 0),
    opsDegradedFeedKillMs:     num('OPS_DEGRADED_FEED_KILL_MS', 60_000, 0),
    opsDiskWarnMb:             num('OPS_DISK_WARN_MB', 1024, 0),

    // CUSUM structural break detection
    opsCusumK:                 num('OPS_CUSUM_K', 2.0, 0),
    opsCusumH:                 num('OPS_CUSUM_H', 10.0, 0),

    // ── Shadow Execution (Phase 8 — Real-Market Readiness) ───────────────────
    // SUPERVISED, DRY-RUN ONLY. Requires LIVE_PAPER_ENABLED=true. There is NO
    // code path that submits real orders. The wallet is address-only by
    // default; signatures are explicitly labeled 'DRYRUN-' and cannot be
    // mistaken for ECDSA signatures.
    shadowEnabled:             bool('SHADOW_ENABLED', false),
    shadowOutputDir:           str('SHADOW_OUTPUT_DIR', './shadow-output'),
    shadowWalletEnabled:       bool('SHADOW_WALLET_ENABLED', false),
    shadowWalletAddress:       str('SHADOW_WALLET_ADDRESS', ''),
    shadowVerifyingContract:   str('SHADOW_VERIFYING_CONTRACT', ''),

    // Sandbox guards
    shadowMaxNotionalUsd:      num('SHADOW_MAX_NOTIONAL_USD', 100, 0),
    shadowSingleStrategyLock:  str('SHADOW_SINGLE_STRATEGY_LOCK', ''),
    shadowHaltFile:            str('SHADOW_HALT_FILE', ''),

    // Approval mode
    shadowAutoApprove:         bool('SHADOW_AUTO_APPROVE', false),
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
