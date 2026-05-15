import { config } from './config/index.js'
import { bus } from './bus/EventBus.js'
import { log } from './utils/logger.js'
import { RtdsClient } from './ws/rtds/RtdsClient.js'
import { ClobClient } from './ws/clob/ClobClient.js'
import { MarketClockEngine } from './engines/MarketClockEngine.js'
import { StateEngine } from './engines/StateEngine.js'
import { MetricsEngine } from './engines/MetricsEngine.js'
import { FeedHealthMonitor } from './monitors/FeedHealthMonitor.js'
import { Terminal } from './terminal/Terminal.js'
import { EventRecorder } from './replay/EventRecorder.js'
import { EventReplayer } from './replay/EventReplayer.js'
import { PersistenceEngine } from './engines/PersistenceEngine.js'
import { DbJournalWriter } from './persistence/DbJournalWriter.js'
import { DbReplayer } from './replay/DbReplayer.js'
import { runMigration } from './db/migrate.js'
import { closePool } from './db/pool.js'
import { SignalEngine } from './signals/SignalEngine.js'
import { SignalObserver } from './research/SignalObserver.js'
import { ResearchSession } from './research/ResearchSession.js'
import { SimulationEngine } from './sim/SimulationEngine.js'
import { LatencyModel } from './sim/LatencyModel.js'
import { CompositeStrategy } from './strategies/CompositeStrategy.js'
import { WhaleFollowStrategy } from './strategies/WhaleFollowStrategy.js'
import { ExecutionAnalytics } from './research/ExecutionAnalytics.js'
import { runValidationSuite } from './validation/ValidationOrchestrator.js'
import { LivePaperEngine } from './live/LivePaperEngine.js'
import type { Strategy } from './strategies/Strategy.js'
import type { SignalFrame, MarketRegime } from './signals/types.js'
import type { MarketSymbol } from './types/market.js'
import type { Suite } from './validation/ValidationOrchestrator.js'

function resolveMode(): 'validation' | 'simulation' | 'research' | 'db-replay' | 'file-replay' | 'live' {
  if (config.validationMode) return 'validation'
  if (config.simulationMode) return 'simulation'
  if (config.researchMode)   return 'research'
  if (config.dbReplayFrom)   return 'db-replay'
  if (config.replayFile)     return 'file-replay'
  return 'live'
}

function buildStrategies(spec: string): Strategy[] {
  const names = spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const out: Strategy[] = []
  for (const name of names) {
    if (name === 'composite' || name === 'composite-signal') out.push(new CompositeStrategy())
    else if (name === 'whale' || name === 'whale-follow')    out.push(new WhaleFollowStrategy())
    else log.warn(`[main] unknown strategy: ${name}`)
  }
  return out.length > 0 ? out : [new CompositeStrategy()]
}

async function main(): Promise<void> {
  const mode = resolveMode()

  log.info('=== Polymarket Microstructure Engine starting ===', {
    mode:        mode.toUpperCase(),
    logLevel:    config.logLevel,
    nodeEnv:     config.nodeEnv,
    persistence: config.persistenceEnabled,
    journal:     config.journalEnabled,
    signals:     config.signalsEnabled,
    simulation:  config.simulationMode,
    validation:  config.validationMode,
    livePaper:   config.livePaperEnabled,
    ops:         config.opsEnabled,
    shadow:      config.shadowEnabled,
  })

  // ── VALIDATION MODE ───────────────────────────────────────────────────────────
  // Phase 5: parameter sweep, walk-forward, Monte Carlo, scenarios, comparison.
  if (mode === 'validation') {
    if (!config.replayFile) {
      log.error('[main] VALIDATION_MODE=true requires REPLAY_FILE to be set')
      process.exit(1)
    }
    const suite = config.validationSuite as Suite
    if (!['sweep', 'walk-forward', 'monte-carlo', 'scenarios', 'compare', 'full'].includes(suite)) {
      log.error(`[main] invalid VALIDATION_SUITE: ${suite}`)
      process.exit(1)
    }
    await runValidationSuite({
      replayFile: config.replayFile,
      suite,
      outputDir:  config.validationOutputDir,
    })
    log.flush()
    process.exit(0)
  }

  // ── SIMULATION MODE ───────────────────────────────────────────────────────────
  // Replay-driven paper execution: replay + signals + strategy + fills + analytics
  if (mode === 'simulation') {
    if (!config.replayFile && !config.dbReplayFrom) {
      log.error('[main] SIMULATION_MODE=true requires REPLAY_FILE or DB_REPLAY_FROM to be set')
      process.exit(1)
    }

    const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

    // Start signal pipeline (needed to drive strategy decisions)
    const signalEngine = new SignalEngine()
    signalEngine.start()

    // Build strategy chain
    const strategies = buildStrategies(config.simStrategy)
    const latency    = new LatencyModel(config.simDecisionLatencyMs, config.simWsLatencyMs, config.simExecutionLatencyMs)

    // Simulation engine
    const sim = new SimulationEngine(latency, strategies)
    sim.start()

    // Track regime per symbol at each oracle.price ts for execution attribution
    const regimeHistory = new Map<MarketSymbol, Array<{ ts: number; regime: MarketRegime }>>()
    bus.on('signal.frame', ({ frame }: { frame: SignalFrame }) => {
      const arr = regimeHistory.get(frame.symbol) ?? []
      arr.push({ ts: frame.ts, regime: frame.regime })
      regimeHistory.set(frame.symbol, arr)
    })
    const regimeByTs = (sym: MarketSymbol, ts: number): MarketRegime | undefined => {
      const arr = regimeHistory.get(sym)
      if (!arr || arr.length === 0) return undefined
      // Binary search for last entry <= ts
      let lo = 0, hi = arr.length - 1, idx = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (arr[mid]!.ts <= ts) { idx = mid; lo = mid + 1 }
        else                       hi = mid - 1
      }
      return idx >= 0 ? arr[idx]!.regime : undefined
    }

    // Run replay
    let firstTs = 0, lastTs = 0
    bus.on('oracle.price', (e) => { if (firstTs === 0) firstTs = e.ts; lastTs = e.ts })

    if (config.dbReplayFrom) {
      if (config.persistenceEnabled && config.dbUrl) await runMigration()
      const replayer = new DbReplayer({
        from:  new Date(config.dbReplayFrom),
        to:    config.dbReplayTo ? new Date(config.dbReplayTo) : undefined,
        speed: config.replaySpeed,
      })
      await replayer.start()
    } else {
      const replayer = new EventReplayer(config.replayFile!, config.replaySpeed)
      await replayer.start()
    }

    sim.stop()

    // Analytics + export
    const analytics = new ExecutionAnalytics(config.simOutputDir, sessionId)
    const report    = analytics.produce(sim, strategies.map(s => s.name).join('+'), firstTs, lastTs, regimeByTs)
    await analytics.exportFills(sim.getPortfolio().getFills())
    await analytics.exportReport(report)
    analytics.printSummary(report)

    if (config.persistenceEnabled) void closePool()
    log.flush()
    process.exit(0)
  }

  // ── RESEARCH MODE ─────────────────────────────────────────────────────────────
  // Replay-driven signal research: replay events → compute signals → validate → export
  if (mode === 'research') {
    const source = config.dbReplayFrom
      ? { type: 'db' as const, from: new Date(config.dbReplayFrom), to: config.dbReplayTo ? new Date(config.dbReplayTo) : undefined }
      : config.replayFile
        ? { type: 'file' as const, path: config.replayFile }
        : null

    if (!source) {
      log.error('[main] RESEARCH_MODE=true requires REPLAY_FILE or DB_REPLAY_FROM to be set')
      process.exit(1)
    }

    if (config.persistenceEnabled && config.dbUrl) await runMigration()

    const session = new ResearchSession(source, config.researchOutputDir, config.replaySpeed)
    await session.run()
    if (config.persistenceEnabled) void closePool()
    log.flush()
    process.exit(0)
  }

  const metricsEngine = new MetricsEngine()
  const healthMonitor = new FeedHealthMonitor()
  const terminal      = new Terminal(metricsEngine, healthMonitor)

  // ── FILE REPLAY MODE ──────────────────────────────────────────────────────────
  if (mode === 'file-replay') {
    const clobClient  = new ClobClient()
    const stateEngine = new StateEngine(clobClient)
    const replayer    = new EventReplayer(config.replayFile!, config.replaySpeed)

    const shutdown = () => {
      log.info('[main] shutting down (file-replay mode)')
      terminal.stop()
      metricsEngine.stop()
      healthMonitor.stop()
      log.flush()
      process.exit(0)
    }
    process.on('SIGINT',  () => shutdown())
    process.on('SIGTERM', () => shutdown())

    metricsEngine.start()
    healthMonitor.start()
    stateEngine.start()
    terminal.start()

    replayer.start()
      .then(() => {
        const hash     = stateEngine.getStateHash()
        const expected = config.expectedStateHash

        if (expected) {
          if (hash === expected) {
            log.info(`[Replay] state hash VERIFIED ✓  ${hash}`)
          } else {
            log.error(`[Replay] state hash MISMATCH — got ${hash}, expected ${expected}`)
          }
        } else {
          log.info(`[Replay] final state hash: ${hash}`)
          log.info(`[Replay] set EXPECTED_STATE_HASH=${hash} to verify determinism on next run`)
        }
        log.info(`[Replay] mutations: ${stateEngine.getMutationCount()}`)
      })
      .catch((err: unknown) =>
        log.error(`[Replayer] fatal: ${err instanceof Error ? err.message : String(err)}`)
      )
    return
  }

  // ── DB REPLAY MODE ────────────────────────────────────────────────────────────
  if (mode === 'db-replay') {
    const clobClient  = new ClobClient()
    const stateEngine = new StateEngine(clobClient)
    const replayer    = new DbReplayer({
      from:  new Date(config.dbReplayFrom!),
      to:    config.dbReplayTo ? new Date(config.dbReplayTo) : undefined,
      speed: config.replaySpeed,
    })

    const shutdown = () => {
      log.info('[main] shutting down (db-replay mode)')
      terminal.stop()
      metricsEngine.stop()
      healthMonitor.stop()
      void closePool()
      log.flush()
      process.exit(0)
    }
    process.on('SIGINT',  () => shutdown())
    process.on('SIGTERM', () => shutdown())

    metricsEngine.start()
    healthMonitor.start()
    stateEngine.start()
    terminal.start()

    replayer.start()
      .then(() => {
        const hash     = stateEngine.getStateHash()
        const expected = config.expectedStateHash

        if (expected) {
          if (hash === expected) {
            log.info(`[DbReplay] state hash VERIFIED ✓  ${hash}`)
          } else {
            log.error(`[DbReplay] state hash MISMATCH — got ${hash}, expected ${expected}`)
          }
        } else {
          log.info(`[DbReplay] final state hash: ${hash}`)
          log.info(`[DbReplay] set EXPECTED_STATE_HASH=${hash} to verify determinism on next run`)
        }
        log.info(`[DbReplay] mutations: ${stateEngine.getMutationCount()}`)
      })
      .catch((err: unknown) =>
        log.error(`[DbReplayer] fatal: ${err instanceof Error ? err.message : String(err)}`)
      )
    return
  }

  // ── LIVE MODE ─────────────────────────────────────────────────────────────────
  const clobClient  = new ClobClient()
  const rtdsClient  = new RtdsClient()
  const clockEngine = new MarketClockEngine()
  const stateEngine = new StateEngine(clobClient)

  // Optional file recorder
  let recorder: EventRecorder | null = null
  if (config.recordEvents) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    recorder = new EventRecorder(`./recordings/${ts}.jsonl`)
    recorder.start()
  }

  // Optional persistence layer (requires DATABASE_URL)
  let persistence: PersistenceEngine | null = null
  let journal:     DbJournalWriter    | null = null
  if (config.persistenceEnabled) {
    if (!config.dbUrl) {
      log.error('[main] PERSISTENCE_ENABLED=true but DATABASE_URL is not set — aborting')
      process.exit(1)
    }
    await runMigration()
    persistence = new PersistenceEngine(metricsEngine)
    persistence.start()

    if (config.journalEnabled) {
      journal = new DbJournalWriter()
      journal.start()
    }
  }

  // Optional signal engine + observability
  // LIVE_PAPER_ENABLED implies signals on (paper trading needs signal frames)
  const signalsActive = config.signalsEnabled || config.livePaperEnabled
  let signalEngine:  SignalEngine  | null = null
  let signalObserver: SignalObserver | null = null
  if (signalsActive) {
    signalEngine   = new SignalEngine()
    signalObserver = new SignalObserver()
    signalEngine.start()
    signalObserver.start()
  }

  // Optional live paper trading (Phase 6) — paper execution + drift + kill-switch
  let livePaper: LivePaperEngine | null = null
  if (config.livePaperEnabled) {
    livePaper = new LivePaperEngine()
    terminal.setLivePaper(livePaper)
    livePaper.start()
  }

  const shutdown = (signal: string) => {
    log.info(`[main] ${signal} — shutting down`)
    terminal.stop()
    rtdsClient.stop()
    clobClient.stop()
    clockEngine.stop()
    metricsEngine.stop()
    healthMonitor.stop()
    if (recorder)      recorder.stop()
    if (persistence)   persistence.stop()
    if (journal)       journal.stop()
    if (livePaper)     livePaper.stop()
    if (signalEngine)  signalEngine.stop()
    const s = stateEngine.getState()
    log.info(`[main] last window: ${s.window.windowTs}  uptime: ${Math.floor(Date.now() / 1000) - s.startedAt}s`)
    log.info(`[main] final state hash: ${stateEngine.getStateHash()}  mutations: ${stateEngine.getMutationCount()}`)
    if (persistence)   log.info('[main] persistence metrics:', persistence.getPersistenceMetrics())
    if (signalObserver) log.info('[main] signal observability:', signalObserver.getMetrics())
    void closePool()
    log.flush()
    process.exit(0)
  }
  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  bus.on('whale.alert', ({ trade }) =>
    log.info(
      `[Whale] ${trade.symbol} ${trade.side} $${trade.sizeUsd.toFixed(0)} ` +
      `(${trade.outcome}) ${trade.wallet.slice(0, 10)}…`
    )
  )

  bus.on('system.warning',   (e) => log.warn(`[Health] warning: ${e.source} — ${e.message}`))
  bus.on('system.degraded',  (e) => log.error(`[Health] DEGRADED: ${e.reason}`))
  bus.on('system.recovered', (e) => log.info(`[Health] recovered: ${e.source}`))

  // Startup sequence (order matters for event ordering)
  metricsEngine.start()   // 1. Counts all events from the start
  healthMonitor.start()   // 2. Tracks feed freshness
  stateEngine.start()     // 3. Processes market data
  terminal.start()        // 4. Renders state snapshots
  rtdsClient.start()      // 5. RTDS connects
  clobClient.start()      // 6. CLOB connects
  clockEngine.start()     // 7. Clock ticks + fetches token IDs from Gamma

  log.info('[main] all engines started')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
