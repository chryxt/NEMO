/**
 * Deterministic additive latency model.
 *
 *   tsArrival = tsSubmit + decisionMs + wsMs + executionMs
 *
 * No randomness — same submit-time always yields the same arrival-time.
 * Allows latency-sensitivity backtests by running the same replay with
 * different configured values.
 */
export class LatencyModel {
  constructor(
    readonly decisionMs:  number,
    readonly wsMs:        number,
    readonly executionMs: number,
  ) {}

  total(): number {
    return this.decisionMs + this.wsMs + this.executionMs
  }

  arrivalTime(tsSubmit: number): number {
    return tsSubmit + this.total()
  }

  describe(): string {
    return `${this.decisionMs}+${this.wsMs}+${this.executionMs}=${this.total()}ms`
  }
}
