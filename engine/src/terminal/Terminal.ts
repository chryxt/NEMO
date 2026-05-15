import { bus } from '../bus/EventBus.js'
import { render } from './renderer.js'
import { makeInitialState } from '../types/market.js'
import type { GlobalState } from '../types/market.js'
import type { MetricsEngine } from '../engines/MetricsEngine.js'
import type { FeedHealthMonitor } from '../monitors/FeedHealthMonitor.js'
import { config } from '../config/index.js'

export class Terminal {
  private currentState: GlobalState = makeInitialState()
  private renderTimer: NodeJS.Timeout | null = null
  private lastRendered = ''

  constructor(
    private readonly metrics: MetricsEngine,
    private readonly health: FeedHealthMonitor,
  ) {}

  start(): void {
    process.stdout.write('\x1B[?25l')
    process.stdout.write('\x1B[2J\x1B[H')

    bus.on('state.snapshot', ({ state }) => {
      this.currentState = state
    })

    this.renderTimer = setInterval(() => this.draw(), config.terminalRefreshMs)
    this.draw()
  }

  stop(): void {
    if (this.renderTimer) clearInterval(this.renderTimer)
    process.stdout.write('\x1B[?25h\n')
  }

  private draw(): void {
    const frame = render(this.currentState, this.metrics.getMetrics(), this.health.getHealth())
    if (frame === this.lastRendered) return

    process.stdout.write('\x1B[H')
    process.stdout.write(frame)
    this.lastRendered = frame
  }
}
