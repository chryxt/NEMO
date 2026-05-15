/**
 * Real EIP-712 signer for Polymarket CTF Exchange orders.
 *
 * Uses viem's signTypedData under the hood — supports both local accounts
 * (env-key path) and JSON-RPC signers (hardware wallet path) transparently.
 *
 * The signature output is a standard 65-byte ECDSA signature (132 hex
 * including 0x prefix) — distinct from the Phase 8 dry-run signature which
 * is 'DRYRUN-' prefixed.
 */
import { log } from '../utils/logger.js'
import type { Hex } from 'viem'
import type { SecureWallet } from './SecureWallet.js'
import type { PolymarketOrderStruct } from '../shadow/types.js'

const DOMAIN_NAME = 'Polymarket CTF Exchange'
const DOMAIN_VERSION = '1'

// EIP-712 typed-data schema for Polymarket Order
const ORDER_TYPES = {
  Order: [
    { name: 'salt',          type: 'uint256' },
    { name: 'maker',         type: 'address' },
    { name: 'signer',        type: 'address' },
    { name: 'taker',         type: 'address' },
    { name: 'tokenId',       type: 'uint256' },
    { name: 'makerAmount',   type: 'uint256' },
    { name: 'takerAmount',   type: 'uint256' },
    { name: 'expiration',    type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
    { name: 'feeRateBps',    type: 'uint256' },
    { name: 'side',          type: 'uint8'   },
    { name: 'signatureType', type: 'uint8'   },
  ],
} as const

export class RealEIP712Signer {
  private signingFailures = 0

  constructor(
    private readonly wallet:            SecureWallet,
    private readonly verifyingContract: Hex,
  ) {}

  /**
   * Sign a Polymarket Order. Returns a hex ECDSA signature.
   * Throws if the wallet is not initialized.
   */
  async signOrder(order: PolymarketOrderStruct): Promise<Hex> {
    if (!this.wallet.isReady()) {
      throw new Error('wallet not initialized')
    }
    const walletClient = this.wallet.getWalletClient()!
    const account = this.wallet.getAccount() ?? this.wallet.getAddress()

    const domain = {
      name:              DOMAIN_NAME,
      version:           DOMAIN_VERSION,
      chainId:           this.wallet.getChainId(),
      verifyingContract: this.verifyingContract,
    } as const

    const message = {
      salt:          BigInt(parseUint(order.salt)),
      maker:         order.maker as Hex,
      signer:        order.signer as Hex,
      taker:         order.taker as Hex,
      tokenId:       BigInt(order.tokenId),
      makerAmount:   BigInt(order.makerAmount),
      takerAmount:   BigInt(order.takerAmount),
      expiration:    BigInt(order.expiration),
      nonce:         BigInt(order.nonce),
      feeRateBps:    BigInt(order.feeRateBps),
      side:          order.side,
      signatureType: order.signatureType,
    }

    try {
      const sig = await walletClient.signTypedData({
        account,
        domain,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message,
      })
      // Sanity check format
      if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
        throw new Error(`unexpected signature shape: length=${sig.length}`)
      }
      return sig
    } catch (err) {
      this.signingFailures++
      log.error(`[RealEIP712Signer] sign failed: ${(err as Error).message}`)
      throw err
    }
  }

  getSigningFailureCount(): number { return this.signingFailures }
}

function parseUint(v: string): string {
  // Accept hex (0x...) or decimal; convert hex to decimal for BigInt constructor
  if (v.startsWith('0x')) return BigInt(v).toString()
  return v
}
