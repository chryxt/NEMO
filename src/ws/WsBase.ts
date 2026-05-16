import WebSocket from 'ws'
import { log } from '../utils/logger.js'

const CONNECT_TIMEOUT_MS = 10_000
const MAX_RECONNECT_DELAY_S = 60

export interface WsBaseConfig {
  url: string
  name: string
  pingIntervalMs: number   // 5000 for RTDS, 10000 for CLOB
  pongTimeoutMs: number    // force reconnect if no pong in this long
}

export abstract class WsBase {
  protected ws: WebSocket | null = null
  protected status: 'connecting' | 'connected' | 'reconnecting' | 'dead' = 'connecting'

  private heartbeatTimer: NodeJS.Timeout | null = null
  private connectTimeoutTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private lastPongMs = 0

  constructor(protected config: WsBaseConfig) {}

  start(): void {
    this.connect()
  }

  stop(): void {
    this.status = 'dead'
    this.clearTimers()
    this.ws?.terminate()
    this.ws = null
  }

  private connect(): void {
    this.clearTimers()
    this.setStatus('connecting')
    log.info(`[${this.config.name}] connecting to ${this.config.url}`)

    const ws = new WebSocket(this.config.url, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    })
    this.ws = ws
    this.lastPongMs = Date.now()

    this.connectTimeoutTimer = setTimeout(() => {
      if (this.status === 'connecting') {
        log.warn(`[${this.config.name}] connect timeout`)
        ws.terminate()
      }
    }, CONNECT_TIMEOUT_MS)

    ws.on('open', () => {
      clearTimeout(this.connectTimeoutTimer!)
      this.reconnectAttempt = 0
      this.lastPongMs = Date.now()
      this.setStatus('connected')
      log.info(`[${this.config.name}] connected`)
      this.onOpen()
      this.startHeartbeat()
    })

    ws.on('message', (data: WebSocket.RawData) => {
      const raw = data.toString()
      if (raw === 'PONG' || raw === 'pong') {
        this.lastPongMs = Date.now()
        return
      }
      try {
        this.onMessage(raw)
      } catch (err) {
        log.warn(`[${this.config.name}] message parse error: ${err}`)
      }
    })

    ws.on('ping', () => {
      ws.pong()
      this.lastPongMs = Date.now()
    })

    ws.on('pong', () => {
      this.lastPongMs = Date.now()
    })

    ws.on('error', (err) => {
      log.warn(`[${this.config.name}] error: ${err.message}`)
    })

    ws.on('close', (code, reason) => {
      this.clearHeartbeat()
      if (this.status === 'dead') return
      log.warn(`[${this.config.name}] closed (${code}) ${reason.toString() || ''}`)
      this.scheduleReconnect()
    })
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

      const staleness = Date.now() - this.lastPongMs
      if (staleness > this.config.pongTimeoutMs) {
        log.warn(`[${this.config.name}] pong timeout (${staleness}ms) — forcing reconnect`)
        this.ws.terminate()
        return
      }

      this.ws.send('PING')
    }, this.config.pingIntervalMs)
  }

  private scheduleReconnect(): void {
    if (this.status === 'dead') return
    this.setStatus('reconnecting')
    const delaySec = Math.min(MAX_RECONNECT_DELAY_S, Math.pow(2, this.reconnectAttempt))
    this.reconnectAttempt++
    log.info(`[${this.config.name}] reconnecting in ${delaySec}s (attempt ${this.reconnectAttempt})`)
    this.reconnectTimer = setTimeout(() => this.connect(), delaySec * 1000)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat()
    if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
  }

  private setStatus(s: typeof this.status): void {
    this.status = s
    this.onStatusChange(s)
  }

  getStatus(): typeof this.status {
    return this.status
  }

  protected send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  // Subclasses implement these
  protected abstract onOpen(): void
  protected abstract onMessage(raw: string): void
  protected onStatusChange(_status: typeof this.status): void {}
}
