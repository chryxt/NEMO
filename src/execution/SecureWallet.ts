/**
 * Secure wallet — viem-backed wallet abstraction with strict secret handling.
 *
 * INVARIANTS:
 *   - Private keys are wrapped in SecureSecret and NEVER serialized
 *   - toString / toJSON / inspect always return '[REDACTED]'
 *   - The secret is only read inside the signer factory; nothing else
 *     gets a handle to the raw bytes
 *   - The wallet supports two activation paths:
 *       a) env-key   — local private key in EXECUTION_PRIVATE_KEY (testnet-class)
 *       b) rpc-signer — JSON-RPC signer URL (hardware wallet / external service)
 *   - If neither configured, signerMethod='none' and the wallet refuses to sign
 *
 * NO logging path includes the secret. We deliberately do NOT add log calls
 * inside this module beyond constructor metadata (which excludes the secret).
 */
import { createWalletClient, createPublicClient, http, custom } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import type {
  WalletClient, PublicClient, Account, Hex, EIP1193RequestFn,
} from 'viem'
import { log } from '../utils/logger.js'

const REDACTED = '[REDACTED]'

/**
 * Wraps a secret so it cannot be accidentally logged. Inspect / JSON / cast
 * all return REDACTED. The only way to read the secret is `unsafeReveal()`,
 * which is named so any future grep audit catches it instantly.
 */
export class SecureSecret {
  readonly #value: string
  constructor(value: string) { this.#value = value }
  toString():         string { return REDACTED }
  toJSON():           string { return REDACTED }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return REDACTED }
  unsafeReveal():     string { return this.#value }
  isEmpty():          boolean { return this.#value.length === 0 }
}

export type SignerMethod = 'env-key' | 'rpc-signer' | 'none'

export interface SecureWalletConfig {
  privateKeyEnvVar:   string   // name of env var to read (NOT the value)
  signerRpcUrl:       string
  rpcUrl:             string
  expectedChainId:    number
}

export class SecureWallet {
  private account:         Account | null = null
  private walletClient:    WalletClient | null = null
  private publicClient:    PublicClient
  private signerMethod:    SignerMethod = 'none'
  private addressValue:    Hex = '0x0000000000000000000000000000000000000000'

  constructor(private readonly cfg: SecureWalletConfig) {
    this.publicClient = createPublicClient({
      chain:     polygon,
      transport: http(cfg.rpcUrl),
    })
  }

  /** Initialize the wallet. Returns SignerMethod or throws on misconfig. */
  async initialize(): Promise<SignerMethod> {
    // Read env via the var NAME (never log the value)
    const rawKey = new SecureSecret(process.env[this.cfg.privateKeyEnvVar] ?? '')
    const rpcSignerUrl = this.cfg.signerRpcUrl

    if (rpcSignerUrl) {
      // External signer path (preferred — hardware wallet or external KMS)
      try {
        const requestFn = makeJsonRpcRequest(rpcSignerUrl)
        const accounts = await requestFn({ method: 'eth_accounts' }) as Hex[]
        if (!accounts || accounts.length === 0) {
          throw new Error('signer RPC returned no accounts')
        }
        this.addressValue = accounts[0]!.toLowerCase() as Hex
        this.walletClient = createWalletClient({
          account:   this.addressValue,
          chain:     polygon,
          transport: custom({ request: requestFn }),
        })
        this.signerMethod = 'rpc-signer'
        log.info('[SecureWallet] initialized via rpc-signer', {
          address:        this.addressValue,
          signerEndpoint: redactUrl(rpcSignerUrl),
        })
        return 'rpc-signer'
      } catch (err) {
        log.error(`[SecureWallet] rpc-signer init failed: ${(err as Error).message}`)
        return 'none'
      }
    }

    if (!rawKey.isEmpty()) {
      // Local env-key path (testnet-class only)
      try {
        const keyHex = rawKey.unsafeReveal()
        const normalized = keyHex.startsWith('0x') ? keyHex : `0x${keyHex}`
        if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
          throw new Error('private key must be 32 bytes (64 hex chars)')
        }
        this.account = privateKeyToAccount(normalized as Hex)
        this.addressValue = this.account.address.toLowerCase() as Hex
        this.walletClient = createWalletClient({
          account:   this.account,
          chain:     polygon,
          transport: http(this.cfg.rpcUrl),
        })
        this.signerMethod = 'env-key'
        log.warn('[SecureWallet] initialized via env-key — testnet-class. Prefer EXECUTION_SIGNER_RPC_URL for production', {
          address: this.addressValue,
        })
        return 'env-key'
      } catch (err) {
        log.error(`[SecureWallet] env-key init failed: ${(err as Error).message}`)
        return 'none'
      }
    }

    this.signerMethod = 'none'
    return 'none'
  }

  isReady():         boolean      { return this.signerMethod !== 'none' && this.walletClient != null }
  getAddress():      Hex          { return this.addressValue }
  getSignerMethod(): SignerMethod { return this.signerMethod }
  getChainId():      number       { return this.cfg.expectedChainId }
  getPublicClient(): PublicClient { return this.publicClient }
  getWalletClient(): WalletClient | null { return this.walletClient }
  getAccount():      Account | null { return this.account }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJsonRpcRequest(url: string): EIP1193RequestFn {
  return (async ({ method, params }) => {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) throw new Error(`signer RPC HTTP ${res.status}`)
    const body = await res.json() as { result?: unknown; error?: { message: string } }
    if (body.error) throw new Error(body.error.message)
    return body.result
  }) as EIP1193RequestFn
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = REDACTED
    if (u.username) u.username = REDACTED
    return u.toString()
  } catch {
    return REDACTED
  }
}
