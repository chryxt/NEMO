import { bus } from '../bus/EventBus'
import { render } from './renderer'
import { makeInitialState } from '../types/market'
import type { GlobalState } from '../types/market'
import type { MetricsEngine } from '../engines/MetricsEngine'
import type { FeedHealthMonitor } from '../monitors/FeedHealthMonitor'
import type { LivePaperEngine } from '../live/LivePaperEngine'
import { config } from '../config/index'

export class Terminal {
  private currentState: GlobalState = makeInitialState()
  private renderTimer: NodeJS.Timeout | null = null
  private lastRendered = ''

  private livePaper: LivePaperEngine | null = null

  constructor(
    private readonly metrics: MetricsEngine,
    private readonly health: FeedHealthMonitor,
  ) {}

  setLivePaper(lp: LivePaperEngine): void { this.livePaper = lp }

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
    const frame = render(
      this.currentState,
      this.metrics.getMetrics(),
      this.health.getHealth(),
      this.livePaper?.snapshot(),
    )
    if (frame === this.lastRendered) return

    process.stdout.write('\x1B[H')
    process.stdout.write(frame)
    this.lastRendered = frame
  }
}
