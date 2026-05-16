/**
 * Polymarket REST client — minimal POST/GET wrapper for order submission
 * and lookup. Uses Node 22 built-in fetch.
 *
 * SAFETY:
 *   - When EXECUTION_DRY_RUN=true (default), POST returns a synthetic response
 *     and never hits the network. Only GET requests (read-only) may proceed.
 *   - All credentials are read at construction time; never logged.
 *   - The client refuses to POST if dryRun=true.
 *
 * AUTH:
 *   Polymarket L2 headers:
 *     POLY-ADDRESS, POLY-API-KEY, POLY-SIGNATURE, POLY-TIMESTAMP,
 *     POLY-PASSPHRASE, POLY-NONCE
 *   These are computed per request — never persisted.
 */
import { createHmac } from 'crypto'
import { log } from '../utils/logger'
import { SecureSecret } from './SecureWallet'

export interface PolymarketCredentials {
  apiKey:        SecureSecret
  apiSecret:     SecureSecret
  apiPassphrase: SecureSecret
}

export interface PostOrderResponse {
  success:           boolean
  errorMsg?:         string
  orderID?:          string
  transactionsHashes?: string[]
  status?:           string
}

export interface GetOrderResponse {
  id:         string
  status:     string
  filled:     number
  size:       number
  price:      number
  fee:        number
  txHashes:   string[]
}

export class PolymarketClient {
  constructor(
    private readonly baseUrl:     string,
    private readonly address:     string,
    private readonly credentials: PolymarketCredentials,
    private readonly dryRun:      boolean,
  ) {}

  hasCredentials(): boolean {
    return !this.credentials.apiKey.isEmpty()
        && !this.credentials.apiSecret.isEmpty()
        && !this.credentials.apiPassphrase.isEmpty()
  }

  /**
   * Submit a signed order. In dry-run mode returns a synthetic response.
   * Throws on transport failure.
   */
  async postOrder(payload: {
    order:         Record<string, string | number>
    owner:         string
    orderType:     string
  }): Promise<PostOrderResponse> {
    if (this.dryRun) {
      return {
        success:  true,
        orderID:  `DRYRUN-${Date.now()}`,
        status:   'matched',
        transactionsHashes: [],
      }
    }
    if (!this.hasCredentials()) {
      throw new Error('cannot POST without complete credentials')
    }
    const path = '/order'
    const body = JSON.stringify(payload)
    const headers = this.signRequest('POST', path, body)
    const res = await fetch(`${this.baseUrl}${path}`, {
      method:  'POST',
      headers,
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`POST /order HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return await res.json() as PostOrderResponse
  }

  async getOrder(remoteOrderId: string): Promise<GetOrderResponse | null> {
    if (!this.hasCredentials()) return null
    const path = `/data/order/${encodeURIComponent(remoteOrderId)}`
    const headers = this.signRequest('GET', path, '')
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { method: 'GET', headers })
      if (!res.ok) {
        log.warn(`[PolymarketClient] GET ${path} → HTTP ${res.status}`)
        return null
      }
      return await res.json() as GetOrderResponse
    } catch (err) {
      log.warn(`[PolymarketClient] GET ${path} threw: ${(err as Error).message}`)
      return null
    }
  }

  // ── Internal: L2 header signing ─────────────────────────────────────────────

  private signRequest(method: string, path: string, body: string): Record<string, string> {
    const ts    = Math.floor(Date.now() / 1000).toString()
    const nonce = Math.floor(Math.random() * 1e9).toString()
    const message = `${ts}${method}${path}${body}`
    const secret = this.credentials.apiSecret.unsafeReveal()
    const sig = createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(message)
      .digest('base64')

    return {
      'content-type':    'application/json',
      'POLY-ADDRESS':    this.address,
      'POLY-API-KEY':    this.credentials.apiKey.unsafeReveal(),
      'POLY-PASSPHRASE': this.credentials.apiPassphrase.unsafeReveal(),
      'POLY-SIGNATURE':  sig,
      'POLY-TIMESTAMP':  ts,
      'POLY-NONCE':      nonce,
    }
  }
}
