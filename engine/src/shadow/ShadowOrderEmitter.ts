/**
 * Shadow order emitter — observes sim.orderSubmitted events and builds
 * Polymarket-shaped shadow orders with dry-run signatures.
 *
 * NO real submission. NO HTTP. NO network calls.
 *
 * The mapping symbol+outcome → tokenId is derived from the latest
 * market.windowOpen event; in replay/sim modes there may be no tokens
 * yet, in which case the shadow order tokenId is left as '0'.
 */
import { bus } from '../bus/EventBus.js'
import { log } from '../utils/logger.js'
import { config } from '../config/index.js'
import { randomBytes } from 'crypto'
import type { MarketSymbol } from '../types/market.js'
import type { Outcome } from '../sim/types.js'
import type {
  ShadowOrder, PolymarketOrderStruct,
} from './types.js'
import type { WalletAdapter } from './WalletAdapter.js'
import type { EIP712Signer } from './EIP712Signer.js'

const USDC_DECIMALS = 6
const SHARE_DECIMALS = 6
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface BookSnapshot { bid: number | null; ask: number | null; depth: number | null }

export class ShadowOrderEmitter {
  private readonly tokenIds:    Record<MarketSymbol, { up: string | null; down: string | null }> = {
    BTC: { up: null, down: null }, ETH: { up: null, down: null }, SOL: { up: null, down: null },
  }
  private readonly books = new Map<string, BookSnapshot>()
  private orderCounter = 0
  private signedCount = 0
  private emitListener: ((order: ShadowOrder) => void) | null = null

  constructor(
    private readonly wallet: WalletAdapter,
    private readonly signer: EIP712Signer,
  ) {}

  onEmit(fn: (order: ShadowOrder) => void): void {
    this.emitListener = fn
  }

  start(): void {
    bus.on('market.windowOpen', (e) => {
      for (const sym of ['BTC', 'ETH', 'SOL'] as MarketSymbol[]) {
        this.tokenIds[sym] = { up: e.tokenIds[sym].up, down: e.tokenIds[sym].down }
      }
    })

    bus.on('clob.bestBidAsk', (e) => {
      const existing = this.books.get(e.tokenId) ?? { bid: null, ask: null, depth: null }
      existing.bid = e.bid
      existing.ask = e.ask
      this.books.set(e.tokenId, existing)
    })

    bus.on('clob.book', (e) => {
      const top = (side: { price: number; size: number }[]): number =>
        side.slice(0, 5).reduce((s, lvl) => s + lvl.size, 0)
      const depth = top(e.bids) + top(e.asks)
      const existing = this.books.get(e.tokenId) ?? { bid: null, ask: null, depth: null }
      existing.depth = depth
      this.books.set(e.tokenId, existing)
    })

    bus.on('sim.orderSubmitted', (intent) => {
      try {
        const order = this.buildShadow(intent)
        if (!order) return
        if (this.emitListener) this.emitListener(order)
      } catch (err) {
        log.error(`[ShadowOrderEmitter] failed to build shadow: ${(err as Error).message}`)
      }
    })
  }

  getOrdersGenerated(): number { return this.orderCounter }
  getSignedCount():     number { return this.signedCount }

  // ── Internal ────────────────────────────────────────────────────────────────

  private buildShadow(intent: {
    orderId:     string
    strategyId:  string
    symbol:      MarketSymbol
    outcome:     Outcome
    side:        'BUY' | 'SELL'
    size:        number
    limitPrice:  number | null
    midAtSubmit: number | null
    tsSubmit:    number
    reason:      string
  }): ShadowOrder | null {
    const tokenId = this.tokenIds[intent.symbol][intent.outcome] ?? '0'
    const price   = intent.limitPrice ?? intent.midAtSubmit ?? 0.5

    const book = this.books.get(tokenId) ?? { bid: null, ask: null, depth: null }
    const bestQuote = intent.side === 'BUY' ? book.ask : book.bid
    const mid = book.bid != null && book.ask != null ? (book.bid + book.ask) / 2 : null
    const spreadBps = (book.bid != null && book.ask != null && mid && mid > 0)
      ? ((book.ask - book.bid) / mid) * 10_000
      : 0

    const fillPrice = bestQuote ?? price
    const slipBps = mid && mid > 0 ? ((fillPrice - mid) / mid) * 10_000 : 0
    const notional = intent.size * fillPrice
    const impact = book.depth && book.depth > 0 ? Math.min(intent.size / book.depth, 1.5) : 0
    const feePreviewUsd = (notional * config.simTakerFeeBps) / 10_000

    const expirationMs = intent.tsSubmit + 60_000
    const nonce = this.wallet.allocateNonce()

    const struct: PolymarketOrderStruct = {
      salt:           '0x' + randomHex32(),
      maker:          this.wallet.getAddress(),
      signer:         this.wallet.getAddress(),
      taker:          ZERO_ADDRESS,
      tokenId:        tokenId,
      makerAmount:    toUint(intent.side === 'BUY' ? notional : intent.size, intent.side === 'BUY' ? USDC_DECIMALS : SHARE_DECIMALS),
      takerAmount:    toUint(intent.side === 'BUY' ? intent.size : notional, intent.side === 'BUY' ? SHARE_DECIMALS : USDC_DECIMALS),
      expiration:     Math.floor(expirationMs / 1000).toString(),
      nonce:          nonce.toString(),
      feeRateBps:     config.simTakerFeeBps.toString(),
      side:           intent.side === 'BUY' ? 0 : 1,
      signatureType:  0,
    }

    const signature = this.signer.dryRunSign(struct)
    this.signedCount++
    this.orderCounter++

    const id = `shadow-${this.orderCounter}-${intent.orderId}`

    return {
      id,
      createdAtMs:   Date.now(),
      simOrderId:    intent.orderId,
      symbol:        intent.symbol,
      outcome:       intent.outcome,
      side:          intent.side,
      tokenId,
      size:          intent.size,
      limitPrice:    price,
      notionalUsd:   notional,
      predictedFill: {
        price:           fillPrice,
        slippageBps:     slipBps,
        spreadBps:       spreadBps,
        bookDepthAtMid:  book.depth ?? null,
        marketImpactEstimate: impact,
      },
      feePreviewUsd,
      expirationMs,
      struct,
      signature,
    }
  }
}

function toUint(value: number, decimals: number): string {
  const scaled = Math.round(value * Math.pow(10, decimals))
  if (!Number.isFinite(scaled) || scaled < 0) return '0'
  return Math.floor(scaled).toString()
}

function randomHex32(): string {
  return randomBytes(32).toString('hex')
}
