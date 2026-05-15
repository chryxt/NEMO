/**
 * Alert manager — bridges health/drift/feed events into structured alerts.
 *
 * Currently emits to log only. Future: can route to webhook / file / DB.
 * Throttling: per-source 30s window so we don't spam during sustained issues.
 */
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'

const ALERT_THROTTLE_MS = 30_000

export class AlertManager {
  private lastEmitMs = new Map<string, number>()

  start(): void {
    bus.on('system.warning', (e) => {
      this.emit(`system.warning:${e.source}`, 'warning', `${e.source} — ${e.message}`)
    })
    bus.on('system.degraded', (e) => {
      this.emit(`system.degraded`, 'critical', e.reason)
    })
    bus.on('system.recovered', (e) => {
      this.emit(`system.recovered:${e.source}`, 'info', `${e.source} recovered`)
    })

    bus.on('drift.alert', (e) => {
      this.emit(`drift:${e.metric}`, e.severity, `${e.metric}: ${e.current.toFixed(4)} vs baseline ${e.baseline.toFixed(4)} (drift ${(e.drift * 100).toFixed(1)}%)`)
    })

    log.info('[AlertManager] started')
  }

  private emit(key: string, severity: 'info' | 'warning' | 'critical', message: string): void {
    const now  = Date.now()
    const last = this.lastEmitMs.get(key) ?? 0
    if (now - last < ALERT_THROTTLE_MS && severity !== 'critical') return
    this.lastEmitMs.set(key, now)

    const prefix = severity === 'critical' ? '[ALERT/CRIT]' : severity === 'warning' ? '[ALERT/WARN]' : '[ALERT/INFO]'
    if (severity === 'critical')      log.error(`${prefix} ${message}`)
    else if (severity === 'warning')  log.warn(`${prefix} ${message}`)
    else                              log.info(`${prefix} ${message}`)
  }
}
