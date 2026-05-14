import { bus } from './bus/EventBus.js'
import { RtdsClient } from './ws/rtds/RtdsClient.js'
import { ClobClient } from './ws/clob/ClobClient.js'
import { MarketClockEngine } from './engines/MarketClockEngine.js'
import { StateEngine } from './engines/StateEngine.js'
import { Terminal } from './terminal/Terminal.js'
import { log } from './utils/logger.js'

async function main(): Promise<void> {
  log.info('=== Polymarket Microstructure Engine starting ===')

  // Instantiate all services
  const clobClient = new ClobClient()
  const rtdsClient = new RtdsClient()
  const clockEngine = new MarketClockEngine()
  const stateEngine = new StateEngine(clobClient)
  const terminal = new Terminal()

  // Wire shutdown
  const shutdown = (signal: string) => {
    log.info(`[main] ${signal} received — shutting down`)
    terminal.stop()
    rtdsClient.stop()
    clobClient.stop()
    clockEngine.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Log whale alerts to stderr so they don't corrupt terminal
  bus.on('whale.alert', ({ trade }) => {
    log.info(
      `[Whale] ${trade.symbol} ${trade.side} $${trade.sizeUsd.toFixed(0)} ` +
      `(${trade.outcome}) ${trade.wallet.slice(0, 10)}…`
    )
  })

  // Startup sequence
  stateEngine.start()   // 1. State listens to bus
  terminal.start()      // 2. Terminal listens to state.snapshot
  rtdsClient.start()    // 3. RTDS connects + emits oracle.price, trade.activity
  clobClient.start()    // 4. CLOB connects (subscriptions set by StateEngine on windowOpen)
  clockEngine.start()   // 5. Clock ticks, fetches Gamma, emits market.windowOpen

  log.info('[main] all engines started')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
