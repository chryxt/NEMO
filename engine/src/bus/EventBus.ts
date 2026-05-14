import { EventEmitter } from 'events'
import type { BusEvents } from '../types/events.js'

type Listener<T> = (event: T) => void

class EventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
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
