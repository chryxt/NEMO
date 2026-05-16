/**
 * Polygon RPC health monitor — block lag, gas price, latency.
 *
 * Periodically samples eth_blockNumber, eth_gasPrice and times each call.
 * Exposes a rolling health report. If health degrades, emits a risk flag
 * via callback so the gateway can route to halt or block submissions.
 */
import { log } from '../utils/logger'
import { RingBuffer } from '../utils/RingBuffer'
import type { PublicClient } from 'viem'
import type { RpcHealth } from './types'

const SAMPLE_INTERVAL_MS    = 15_000
const LATENCY_BUFFER        = 60
const GAS_BUFFER            = 60

export class RpcHealthMonitor {
  private latencies = new RingBuffer<number>(LATENCY_BUFFER)
  private gasGwei   = new RingBuffer<number>(GAS_BUFFER)
  private lastBlockNumber: bigint | null = null
  private lastBlockTs:     number | null = null
  private consecutiveFailures = 0
  private timer: NodeJS.Timeout | null = null

  private maxBlockLagSecs: number
  private maxGasGwei:      number
  private maxLatencyMs:    number

  constructor(
    private readonly publicClient: PublicClient,
    bounds: { maxBlockLagSecs: number; maxGasGwei: number; maxLatencyMs: number },
    private readonly onDegrade: (detail: string) => void,
  ) {
    this.maxBlockLagSecs = bounds.maxBlockLagSecs
    this.maxGasGwei      = bounds.maxGasGwei
    this.maxLatencyMs    = bounds.maxLatencyMs
  }

  start(): void {
    this.timer = setInterval(() => { void this.sample() }, SAMPLE_INTERVAL_MS)
    void this.sample()
    log.info('[RpcHealthMonitor] started', {
      maxBlockLagSecs: this.maxBlockLagSecs,
      maxGasGwei:      this.maxGasGwei,
      maxLatencyMs:    this.maxLatencyMs,
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async sample(): Promise<void> {
    const start = Date.now()
    try {
      const block   = await this.publicClient.getBlockNumber()
      const gasWei  = await this.publicClient.getGasPrice()
      const elapsed = Date.now() - start
      this.latencies.push(elapsed)
      const gwei = Number(gasWei) / 1e9
      this.gasGwei.push(gwei)

      // Detect a stale RPC (block number not advancing)
      if (this.lastBlockNumber != null && block === this.lastBlockNumber) {
        const ageSec = ((Date.now() - (this.lastBlockTs ?? Date.now())) / 1000)
        if (ageSec > this.maxBlockLagSecs) {
          this.onDegrade(`block stalled at ${block} for ${ageSec.toFixed(0)}s`)
        }
      } else {
        this.lastBlockNumber = block
        this.lastBlockTs     = Date.now()
      }

      if (gwei > this.maxGasGwei) {
        this.onDegrade(`gas spike ${gwei.toFixed(1)} gwei > ${this.maxGasGwei}`)
      }
      if (elapsed > this.maxLatencyMs) {
        this.onDegrade(`rpc slow ${elapsed}ms > ${this.maxLatencyMs}ms`)
      }
      this.consecutiveFailures = 0
    } catch (err) {
      this.consecutiveFailures++
      log.warn(`[RpcHealthMonitor] sample failed: ${(err as Error).message}`)
      if (this.consecutiveFailures >= 3) {
        this.onDegrade(`rpc unreachable (${this.consecutiveFailures} consecutive failures)`)
      }
    }
  }

  getReport(): RpcHealth {
    const lats = this.latencies.toArray()
    const gas  = this.gasGwei.toArray()
    const p99Lat = lats.length >= 5
      ? [...lats].sort((a, b) => a - b)[Math.floor(lats.length * 0.99)] ?? 0
      : 0
    const avgGas = gas.length > 0 ? gas.reduce((a, b) => a + b, 0) / gas.length : 0
    const blockAge = this.lastBlockTs ? (Date.now() - this.lastBlockTs) / 1000 : null
    const latestGas = gas[gas.length - 1] ?? null
    const latestLat = lats[lats.length - 1] ?? null

    let ok = true
    let reason: string | null = null
    if (this.consecutiveFailures >= 3) {
      ok = false; reason = `${this.consecutiveFailures} consecutive failures`
    } else if (blockAge != null && blockAge > this.maxBlockLagSecs) {
      ok = false; reason = `block lag ${blockAge.toFixed(0)}s`
    } else if (latestGas != null && latestGas > this.maxGasGwei) {
      ok = false; reason = `gas ${latestGas.toFixed(1)} gwei`
    } else if (p99Lat > this.maxLatencyMs) {
      ok = false; reason = `p99 latency ${p99Lat}ms`
    }

    return {
      generatedAtMs:      Date.now(),
      ok,
      reason,
      blockNumber:        this.lastBlockNumber,
      blockAgeSecs:       blockAge,
      gasPriceGwei:       latestGas,
      rpcLatencyMs:       latestLat,
      p99LatencyMs:       p99Lat,
      avgGasGwei:         avgGas,
      consecutiveFailures:this.consecutiveFailures,
    }
  }
}
