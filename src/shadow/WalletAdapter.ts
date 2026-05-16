/**
 * Wallet adapter — abstraction for the operator wallet used to anchor shadow
 * orders. This phase intentionally does NOT support real signing or broadcast.
 *
 * Invariants enforced by this module:
 *   - Private keys are never read, never stored, never accepted as input.
 *   - The adapter exposes only a public address and a monotonic nonce counter.
 *   - All signing flows produced are explicitly labeled 'dry-run'.
 *   - When SHADOW_WALLET_ENABLED=false (default), even the address is a
 *     placeholder so accidental on-chain reference is impossible.
 */
import { log } from '../utils/logger.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export class WalletAdapter {
  private readonly enabled:        boolean
  private readonly publicAddress:  string
  private readonly chainId:        number
  private readonly verifyingContract: string
  private nonceCounter: bigint = 0n

  constructor(
    enabled:           boolean,
    publicAddress:     string,
    chainId:           number,
    verifyingContract: string,
  ) {
    this.enabled = enabled
    if (enabled && publicAddress && publicAddress !== ZERO_ADDRESS) {
      // Sanity check — refuse anything that even smells like a private key
      if (publicAddress.length !== 42 || !publicAddress.startsWith('0x')) {
        log.error(`[WalletAdapter] refusing invalid public address — falling back to zero`)
        this.publicAddress = ZERO_ADDRESS
        this.enabled = false
      } else {
        this.publicAddress = publicAddress.toLowerCase()
      }
    } else {
      this.publicAddress = ZERO_ADDRESS
    }
    this.chainId = chainId
    this.verifyingContract = verifyingContract.toLowerCase()
    log.info('[WalletAdapter] constructed', {
      enabled:           this.enabled,
      address:           this.publicAddress,
      chainId:           this.chainId,
      verifyingContract: this.verifyingContract,
      note:              this.enabled ? 'dry-run only — no broadcast capability' : 'disabled',
    })
  }

  // ── Read-only accessors ─────────────────────────────────────────────────────

  isEnabled():            boolean { return this.enabled }
  getAddress():           string  { return this.publicAddress }
  getChainId():           number  { return this.chainId }
  getVerifyingContract(): string  { return this.verifyingContract }

  // Allocate the next nonce for this session. Deterministic in replay because
  // it's a pure counter unaffected by wall-clock.
  allocateNonce(): bigint {
    const n = this.nonceCounter
    this.nonceCounter += 1n
    return n
  }

  // Inspect current next-nonce without consuming it
  peekNonce(): bigint { return this.nonceCounter }

  // Reset for tests / new session
  resetNonce(): void { this.nonceCounter = 0n }
}
