/**
 * Nonce manager — keeps the local nonce in sync with the on-chain CTF
 * Exchange contract via viem publicClient.
 *
 * The CTF Exchange exposes `nextNonce(address maker) → uint256`. We
 * periodically refresh and detect desync.
 *
 * NEVER advances the on-chain nonce. Only reads it.
 */
import { log } from '../utils/logger.js'
import type { Hex, PublicClient } from 'viem'

const REFRESH_INTERVAL_MS = 30_000

const CTF_EXCHANGE_ABI = [
  {
    name:    'nextNonce',
    type:    'function',
    stateMutability: 'view',
    inputs:  [{ name: 'maker', type: 'address' }],
    outputs: [{ name: '',      type: 'uint256' }],
  },
] as const

export class NonceManager {
  private localNonce:  bigint = 0n
  private remoteNonce: bigint | null = null
  private mismatches  = 0
  private refreshTimer: NodeJS.Timeout | null = null
  private lastError:    string | null = null

  constructor(
    private readonly publicClient: PublicClient,
    private readonly contract:     Hex,
    private readonly maker:        Hex,
    private readonly onMismatch:   (detail: string) => void,
  ) {}

  async start(): Promise<void> {
    await this.refresh()
    this.refreshTimer = setInterval(() => { void this.refresh() }, REFRESH_INTERVAL_MS)
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
  }

  /** Allocate the next nonce. Returns the current local value, then increments. */
  allocate(): bigint {
    const n = this.localNonce
    this.localNonce += 1n
    return n
  }

  getLocal():  bigint { return this.localNonce }
  getRemote(): bigint | null { return this.remoteNonce }
  getMismatchCount(): number { return this.mismatches }
  getLastError(): string | null { return this.lastError }

  /** Read on-chain nonce and detect desync. */
  async refresh(): Promise<void> {
    try {
      const remote = await this.publicClient.readContract({
        address:      this.contract,
        abi:          CTF_EXCHANGE_ABI,
        functionName: 'nextNonce',
        args:         [this.maker],
      }) as bigint
      this.remoteNonce = remote
      this.lastError = null

      if (this.localNonce < remote) {
        // Local is stale (another client or wallet submitted) — sync up
        log.warn(`[NonceManager] local nonce ${this.localNonce} < remote ${remote} — syncing`)
        this.localNonce = remote
      } else if (this.localNonce > remote + 50n) {
        // Local is too far ahead — unusual
        const detail = `local nonce ${this.localNonce} >> remote ${remote}`
        this.mismatches++
        this.onMismatch(detail)
        log.error(`[NonceManager] desync: ${detail}`)
      }
    } catch (err) {
      const msg = (err as Error).message
      this.lastError = msg
      log.warn(`[NonceManager] refresh failed: ${msg}`)
    }
  }
}
