import { EventEmitter } from 'events'
import type { BusEvents } from '../types/events.js'

type Listener<T> = (event: T) => void

class EventBus {
  private emitter = new EventEmitter()
  private tapFn: ((event: string, payload: unknown) => void) | null = null
  private tapFns: Array<(event: string, payload: unknown) => void> = []

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  // Multiple tap slots — used by EventRecorder, DbJournalWriter, etc.
  tap(fn: (event: string, payload: unknown) => void): void {
    this.tapFn = fn
  }

  tapMany(fn: (event: string, payload: unknown) => void): void {
    this.tapFns.push(fn)
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.tapFn?.(event as string, payload)
    for (const fn of this.tapFns) fn(event as string, payload)
    this.emitter.emit(event as string, payload)
  }

  on<K extends keyof BusEvents>(event: K, listener: Listener<BusEvents[K]>): void {
    this.emitter.on(event as string, listener as (...args: unknown[]) => void)
  }

  once<K extends keyof BusEvents>(event: K, listener: Listener<BusEvents[K]>): void {
    this.emitter.once(event as string, listener as (...args: unknown[]) => void)
  }

  off<K extends keyof BusEvents>(event: K, listener: Listener<BusEvents[K]>): void {
    this.emitter.off(event as string, listener as (...args: unknown[]) => void)
  }
}

export const bus = new EventBus()
