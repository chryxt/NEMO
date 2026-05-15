import { createWriteStream, mkdirSync } from 'fs'
import { join } from 'path'
import { log } from '../utils/logger.js'
import type { SignalFrame, ResearchReport } from '../signals/types.js'

// Flatten a SignalFrame to a single-level record for CSV/JSONL row export
function flattenFrame(f: SignalFrame): Record<string, string | number | boolean> {
  return {
    ts:                    f.ts,
    symbol:                f.symbol,
    windowTs:              f.features.window.windowTs,
    secondsToClose:        f.features.window.secondsToClose,
    windowProgress:        +f.features.window.windowProgress.toFixed(4),
    isNearSettle:          f.features.window.isNearSettle ? 1 : 0,

    oraclePrice:           f.features.oracle.price           ?? '',
    oracleMomentum30s:     f.features.oracle.momentum30s     ?? '',
    oracleMomentum60s:     f.features.oracle.momentum60s     ?? '',
    oracleVolatility30s:   f.features.oracle.volatility30s   ?? '',
    oracleAcceleration:    f.features.oracle.acceleration     ?? '',
    oracleZscore60s:       f.features.oracle.zscore60s       ?? '',

    orderflowImbalance:    +f.features.orderflow.imbalance.toFixed(4),
    cumulativeDelta:       +f.features.orderflow.cumulativeDelta.toFixed(2),
    buyVolume:             +f.features.orderflow.buyVolume.toFixed(2),
    sellVolume:            +f.features.orderflow.sellVolume.toFixed(2),
    tradeCount:            f.features.orderflow.tradeCount,
    deltaVelocity:         +f.features.orderflow.deltaVelocity.toFixed(4),
    tradeVelocity:         +f.features.orderflow.tradeVelocity.toFixed(2),

    bid:                   f.features.quotes.bid              ?? '',
    ask:                   f.features.quotes.ask              ?? '',
    mid:                   f.features.quotes.mid              ?? '',
    spread:                f.features.quotes.spread           ?? '',
    spreadMA:              f.features.quotes.spreadMA         ?? '',
    spreadZscore:          f.features.quotes.spreadZscore     ?? '',
    spreadSlope:           f.features.quotes.spreadSlope      ?? '',
    midVelocity:           f.features.quotes.midVelocity      ?? '',
    midAccel:              f.features.quotes.midAccel         ?? '',

    whaleDelta60s:         +f.features.whales.delta60s.toFixed(2),
    whaleVolume60s:        +f.features.whales.volume60s.toFixed(2),
    whaleCount60s:         f.features.whales.count60s,
    whaleConcentration:    +f.features.whales.concentration.toFixed(4),
    whaleAggression:       +f.features.whales.aggression.toFixed(2),
    whaleDominantSide:     f.features.whales.dominantSide,

    sigOrderflow:          +f.signals.orderflow.value.toFixed(4),
    sigOrderflowConf:      +f.signals.orderflow.confidence.toFixed(4),
    sigMomentum:           +f.signals.momentum.value.toFixed(4),
    sigMomentumConf:       +f.signals.momentum.confidence.toFixed(4),
    sigSpread:             +f.signals.spread.value.toFixed(4),
    sigSpreadConf:         +f.signals.spread.confidence.toFixed(4),
    sigWhale:              +f.signals.whale.value.toFixed(4),
    sigWhaleConf:          +f.signals.whale.confidence.toFixed(4),
    sigPositioning:        +f.signals.positioning.value.toFixed(4),
    sigPositioningConf:    +f.signals.positioning.confidence.toFixed(4),

    compositeValue:        +f.composite.value.toFixed(4),
    compositeConf:         +f.composite.confidence.toFixed(4),
    compositeDirection:    f.composite.direction,
    compositeAgreement:    +f.composite.agreement.toFixed(4),

    regime:                f.regime,
  }
}

function escapeCsv(v: string | number | boolean): string {
  const s = String(v)
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

export class ExportPipeline {
  constructor(private readonly outputDir: string) {
    mkdirSync(outputDir, { recursive: true })
  }

  async exportJsonl(frames: SignalFrame[], filename: string): Promise<string> {
    const path = join(this.outputDir, filename)
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(path)
      ws.on('error', reject)
      ws.on('finish', resolve)
      for (const frame of frames) {
        ws.write(JSON.stringify(flattenFrame(frame)) + '\n')
      }
      ws.end()
    })
    log.info(`[ExportPipeline] JSONL written: ${path}  (${frames.length} rows)`)
    return path
  }

  async exportCsv(frames: SignalFrame[], filename: string): Promise<string> {
    if (frames.length === 0) {
      log.warn('[ExportPipeline] no frames to export')
      return ''
    }
    const path = join(this.outputDir, filename)
    const firstRow = flattenFrame(frames[0]!)
    const headers  = Object.keys(firstRow)

    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(path)
      ws.on('error', reject)
      ws.on('finish', resolve)
      ws.write(headers.join(',') + '\n')
      for (const frame of frames) {
        const row = flattenFrame(frame)
        ws.write(headers.map(h => escapeCsv(row[h] ?? '')).join(',') + '\n')
      }
      ws.end()
    })
    log.info(`[ExportPipeline] CSV written: ${path}  (${frames.length} rows, ${headers.length} columns)`)
    log.info(`[ExportPipeline] Convert to Parquet: python3 -c "import pandas as pd; pd.read_csv('${path}').to_parquet('${path.replace('.csv', '.parquet')}')"`)
    return path
  }

  async exportReport(report: ResearchReport, filename: string): Promise<string> {
    const path = join(this.outputDir, filename)
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(path)
      ws.on('error', reject)
      ws.on('finish', resolve)
      ws.write(JSON.stringify(report, null, 2) + '\n')
      ws.end()
    })
    log.info(`[ExportPipeline] report written: ${path}`)
    return path
  }
}
