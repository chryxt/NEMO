/**
 * Monte Carlo stress test.
 *
 * Each MC run applies seeded perturbations to the event stream:
 *   - Latency jitter: gaussian noise added to timestamps (clamped to preserve ordering)
 *   - Whale alert timing: uniform ± shift
 *   - Spread multiplier: gaussian N(1, σ²) applied to bid/ask events
 *   - Slippage extra: fixed bps added to all fill prices (via extra spread)
 *
 * Output: distribution of outcomes (mean/std/p5/p95/probability of loss).
 * Robust strategies have tight distributions. Overfit strategies tail.
 */
import { log } from '../utils/logger'
import { runIsolatedSim } from './ReplayRunner'
import { SeededRandom } from './Random'
import type { LatencyModel } from '../sim/LatencyModel'
import type { Strategy } from '../strategies/Strategy'
import type {
  RecordedEvent, MonteCarloPerturbation, MonteCarloResult, MonteCarloRun,
} from './types'
import type {
  ClobBestBidAskEvent, ClobPriceChangeEvent, WhaleAlertEvent,
} from '../types/events'

export interface MonteCarloSpec {
  events:        RecordedEvent[]
  strategies:    Strategy[]
  latency:       LatencyModel
  perturbation:  MonteCarloPerturbation
  numRuns:       number
  baseSeed:      number
}

/**
 * Build a deterministic event transformer for one MC run.
 * The transformer is a closure over a seeded RNG; same seed → same transformation.
 */
function buildTransformer(rng: SeededRandom, p: MonteCarloPerturbation) {
  return (event: RecordedEvent): RecordedEvent | null => {
    let ts = event.ts
    let payload = event.payload

    // Latency jitter: shift timestamp by gaussian noise (clamped >= 0)
    if (p.latencyJitterMs && p.latencyJitterMs > 0) {
      const jitter = rng.gauss(0, p.latencyJitterMs)
      ts = Math.max(0, ts + Math.round(jitter))
    }

    switch (event.event) {
      case 'whale.alert':
        if (p.whaleShiftMs && p.whaleShiftMs > 0) {
          const shift = rng.range(-p.whaleShiftMs, p.whaleShiftMs)
          const w = payload as WhaleAlertEvent
          payload = { trade: { ...w.trade, ts: w.trade.ts + Math.round(shift / 1000) } }
        }
        break

      case 'clob.bestBidAsk': {
        if (p.spreadMultiplierStd && p.spreadMultiplierStd > 0) {
          const bba = payload as ClobBestBidAskEvent
          const mid = (bba.bid + bba.ask) / 2
          const baseHalfSpread = (bba.ask - bba.bid) / 2
          const mult = Math.max(0.1, rng.gauss(1, p.spreadMultiplierStd))
          const newHalfSpread = baseHalfSpread * mult
          payload = {
            ...bba,
            bid: Math.max(0, mid - newHalfSpread),
            ask: Math.min(1, mid + newHalfSpread),
          }
        }
        // Slippage extra: widen ask & narrow bid by N bps to simulate worse fills
        if (p.slippageBpsExtra && p.slippageBpsExtra > 0) {
          const bba = payload as ClobBestBidAskEvent
          const widen = (bba.bid + bba.ask) / 2 * (p.slippageBpsExtra / 10_000) / 2
          payload = {
            ...bba,
            bid: Math.max(0, bba.bid - widen),
            ask: Math.min(1, bba.ask + widen),
          }
        }
        break
      }

      case 'clob.priceChange': {
        if (p.spreadMultiplierStd && p.spreadMultiplierStd > 0) {
          const pc = payload as ClobPriceChangeEvent
          const mid = (pc.bestBid + pc.bestAsk) / 2
          const baseHalfSpread = (pc.bestAsk - pc.bestBid) / 2
          const mult = Math.max(0.1, rng.gauss(1, p.spreadMultiplierStd))
          const newHalfSpread = baseHalfSpread * mult
          payload = {
            ...pc,
            bestBid: Math.max(0, mid - newHalfSpread),
            bestAsk: Math.min(1, mid + newHalfSpread),
          }
        }
        break
      }

      default:
        break
    }

    return { ts, event: event.event, payload }
  }
}

export function runMonteCarlo(spec: MonteCarloSpec): MonteCarloResult {
  log.info(`[MonteCarlo] starting ${spec.numRuns} runs  perturbation=${JSON.stringify(spec.perturbation)}`)

  const runs: MonteCarloRun[] = []
  for (let i = 0; i < spec.numRuns; i++) {
    const seed = spec.baseSeed + i
    const rng  = new SeededRandom(seed)
    const transformer = buildTransformer(rng, spec.perturbation)

    const result = runIsolatedSim({
      events:      spec.events,
      strategies:  spec.strategies,
      latency:     spec.latency,
      transformer,
      label:       `mc-${i}-seed${seed}`,
    })

    runs.push({ seed, report: result.report, metrics: result.metrics })

    if ((i + 1) % 10 === 0 || i === spec.numRuns - 1) {
      log.info(`[MonteCarlo] ${i + 1}/${spec.numRuns}  pnl=$${result.report.totalPnl.toFixed(2)}  sharpe=${result.metrics.sharpe.toFixed(2)}`)
    }
  }

  // Aggregate distribution
  const pnls    = runs.map(r => r.report.totalPnl).sort((a, b) => a - b)
  const sharpes = runs.map(r => r.metrics.sharpe).sort((a, b) => a - b)
  const drawdowns = runs.map(r => r.metrics.maxDrawdown)

  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1)
  const std  = (xs: number[], m: number) => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(xs.length, 1))
  const pct  = (sorted: number[], p: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))] ?? 0

  const pnlMean = mean(pnls)
  const sharpeMean = mean(sharpes)

  return {
    numRuns:           spec.numRuns,
    perturbation:      spec.perturbation,
    runs,
    pnlMean,
    pnlStd:            std(pnls, pnlMean),
    pnlP5:             pct(pnls, 0.05),
    pnlP95:            pct(pnls, 0.95),
    pnlMedian:         pct(pnls, 0.50),
    probabilityOfLoss: pnls.filter(p => p < 0).length / pnls.length,
    sharpeMean,
    sharpeStd:         std(sharpes, sharpeMean),
    worstDrawdown:     Math.max(...drawdowns, 0),
  }
}
