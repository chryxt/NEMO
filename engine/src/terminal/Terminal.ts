import { bus } from '../bus/EventBus.js'
import { render } from './renderer.js'
import type { GlobalState } from '../types/market.js'
import { makeInitialState } from '../types/market.js'

const REFRESH_MS = Number(process.env['TERMINAL_REFRESH_MS'] ?? 500)

export class Terminal {
  private currentState: GlobalState = makeInitialState()
  private renderTimer: NodeJS.Timeout | null = null
  private lastRendered = ''

  start(): void {
    // Hide cursor and clear screen
    process.stdout.write('\x1B[?25l')
    process.stdout.write('\x1B[2J\x1B[H')

    bus.on('state.snapshot', ({ state }) => {
      this.currentState = state
    })

    this.renderTimer = setInterval(() => this.draw(), REFRESH_MS)
    this.draw()
  }

  stop(): void {
    if (this.renderTimer) clearInterval(this.renderTimer)
    // Restore cursor
    process.stdout.write('\x1B[?25h\n')
  }

  private draw(): void {
    const frame = render(this.currentState)
    if (frame === this.lastRendered) return  // Skip no-change frames

    // Move cursor to home and overwrite
    process.stdout.write('\x1B[H')
    process.stdout.write(frame)
    this.lastRendered = frame
  }
}
