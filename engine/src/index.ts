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

async function main(): Promise<void> {
  log.info('=== Polymarket Microstructure Engine starting ===', {
    mode:     config.replayFile ? 'REPLAY' : config.recordEvents ? 'RECORD+LIVE' : 'LIVE',
    logLevel: config.logLevel,
    nodeEnv:  config.nodeEnv,
  })

  const metricsEngine = new MetricsEngine()
  const healthMonitor = new FeedHealthMonitor()
  const terminal      = new Terminal(metricsEngine, healthMonitor)

  // ── REPLAY MODE ─────────────────────────────────────────────────────────────
  if (config.replayFile) {
    const clobClient  = new ClobClient()
    const stateEngine = new StateEngine(clobClient)
    const replayer    = new EventReplayer(config.replayFile, config.replaySpeed)

    const shutdown = () => {
      log.info('[main] shutting down (replay mode)')
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
        // Log final state hash for determinism verification
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

  // ── LIVE MODE ────────────────────────────────────────────────────────────────
  const clobClient  = new ClobClient()
  const rtdsClient  = new RtdsClient()
  const clockEngine = new MarketClockEngine()
  const stateEngine = new StateEngine(clobClient)

  // Optional recorder
  let recorder: EventRecorder | null = null
  if (config.recordEvents) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    recorder = new EventRecorder(`./recordings/${ts}.jsonl`)
    recorder.start()
  }

  const shutdown = (signal: string) => {
    log.info(`[main] ${signal} — shutting down`)
    terminal.stop()
    rtdsClient.stop()
    clobClient.stop()
    clockEngine.stop()
    metricsEngine.stop()
    healthMonitor.stop()
    if (recorder) recorder.stop()
    const s = stateEngine.getState()
    log.info(`[main] last window: ${s.window.windowTs}  uptime: ${Math.floor(Date.now() / 1000) - s.startedAt}s`)
    log.info(`[main] final state hash: ${stateEngine.getStateHash()}  mutations: ${stateEngine.getMutationCount()}`)
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
