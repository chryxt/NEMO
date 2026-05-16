/**
 * Dry-run EIP-712 signer.
 *
 * Produces a CANONICAL hash of the Polymarket Order struct and a labeled
 * "DRYRUN-…" pseudo-signature so the shadow pipeline can flow end-to-end
 * without depending on any real ECDSA / secp256k1 library.
 *
 * INVARIANT:
 *   - The output is NEVER a valid Ethereum signature.
 *   - Every signature string starts with 'DRYRUN-' so downstream consumers
 *     can refuse it.
 *   - No external network access. No private keys. No on-chain side effects.
 *
 * A real signing implementation would replace `dryRunSign()` with viem's
 * `signTypedData()` — that change is deliberately deferred.
 */
import { createHash } from 'crypto'
import { log } from '../utils/logger'
import type { WalletAdapter } from './WalletAdapter'
import type { PolymarketOrderStruct, ShadowSignature } from './types'

const DRYRUN_PREFIX = 'DRYRUN-'
const POLY_DOMAIN_NAME = 'Polymarket CTF Exchange'
const POLY_DOMAIN_VERSION = '1'

export class EIP712Signer {
  private signingFailures = 0

  constructor(private readonly wallet: WalletAdapter) {}

  /** Build the canonical EIP-712 domain object (informational only). */
  domain(): Record<string, string | number> {
    return {
      name:              POLY_DOMAIN_NAME,
      version:           POLY_DOMAIN_VERSION,
      chainId:           this.wallet.getChainId(),
      verifyingContract: this.wallet.getVerifyingContract(),
    }
  }

  /**
   * Produce a deterministic dry-run signature for an order struct.
   *
   * Hash includes the domain so two different deployments cannot collide.
   * Returned value cannot be mistaken for a real ECDSA signature because:
   *   - prefix 'DRYRUN-' is invalid in Ethereum signature parsing
   *   - hex payload is SHA-256 (64 chars), real sigs are 130 hex chars
   */
  dryRunSign(order: PolymarketOrderStruct): ShadowSignature {
    try {
      const canonical = canonicalJson({ domain: this.domain(), order })
      const hash = createHash('sha256').update(canonical).digest('hex')
      const sig: ShadowSignature = {
        mode:      'dry-run',
        algorithm: 'SHA256-DRYRUN',
        value:     `${DRYRUN_PREFIX}0x${hash}`,
        hash:      `0x${hash}`,
        signedAt:  Date.now(),
      }
      return sig
    } catch (err) {
      this.signingFailures++
      log.error(`[EIP712Signer] dry-run sign failed: ${(err as Error).message}`)
      throw err
    }
  }

  /**
   * Validate that a signature is a well-formed dry-run signature.
   * Used by downstream code to ensure no real signature accidentally leaks in.
   */
  validateDryRun(sig: ShadowSignature): boolean {
    if (sig.mode !== 'dry-run') return false
    if (sig.algorithm !== 'SHA256-DRYRUN') return false
    if (!sig.value.startsWith(DRYRUN_PREFIX)) return false
    if (!/^0x[0-9a-f]{64}$/.test(sig.hash)) return false
    return true
  }

  getSigningFailureCount(): number { return this.signingFailures }
}

/** Stable key-sorted JSON serialization. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) sorted[k] = sortKeys(o[k])
    return sorted
  }
  return value
}
