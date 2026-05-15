/**
 * Deterministic seeded random number generator (xorshift32).
 *
 * Same seed always produces same sequence. Required for reproducible
 * Monte Carlo runs in the validation framework.
 *
 * Output of next() is in [0, 1).
 */
export class SeededRandom {
  private state: number

  constructor(seed: number) {
    // xorshift requires a non-zero state; coerce 0 → DEADBEEF
    this.state = seed === 0 ? 0xDEADBEEF : (seed >>> 0)
  }

  // Uniform [0, 1)
  next(): number {
    let x = this.state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.state = x >>> 0
    return this.state / 0x100000000
  }

  // Uniform [min, max)
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  // Integer uniform [min, max] inclusive
  intRange(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  // Gaussian with given mean / std (Box-Muller)
  gauss(mean: number, std: number): number {
    const u1 = Math.max(this.next(), 1e-10)
    const u2 = this.next()
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }

  // Returns true with probability p
  chance(p: number): boolean {
    return this.next() < p
  }
}
