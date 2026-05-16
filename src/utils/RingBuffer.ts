export class RingBuffer<T> {
  private buf: (T | undefined)[]
  private head = 0
  private _size = 0

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity)
  }

  push(item: T): void {
    this.buf[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this._size < this.capacity) this._size++
  }

  // Returns elements in insertion order (oldest → newest)
  toArray(): T[] {
    if (this._size === 0) return []
    if (this._size < this.capacity) return this.buf.slice(0, this._size) as T[]
    const out: T[] = new Array(this.capacity)
    for (let i = 0; i < this.capacity; i++) {
      out[i] = this.buf[(this.head + i) % this.capacity] as T
    }
    return out
  }

  last(): T | undefined {
    if (this._size === 0) return undefined
    return this.buf[(this.head - 1 + this.capacity) % this.capacity]
  }

  get size(): number { return this._size }
}
