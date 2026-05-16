/**
 * Execution journal — immutable, hash-chained, forensic log of every
 * gateway decision, signed order, REST call, operator action, and fill
 * confirmation.
 *
 * Same hash-chain construction as Phase 8 AuditLog. Separate file because
 * shadow audit is one stream and execution journal is the regulated record
 * for real-money actions.
 */
import { createHash } from 'crypto'
import { createWriteStream, mkdirSync } from 'fs'
import type { WriteStream } from 'fs'
import { join } from 'path'
import { log } from '../utils/logger'

const ZERO_HASH = '0'.repeat(64)

export interface JournalEntry {
  seq:      number
  ts:       number
  type:     string
  actor:    string
  payload:  unknown
  prevHash: string
  hash:     string
}

export class ExecutionJournal {
  private stream: WriteStream | null = null
  private seq                       = 0
  private prevHash                  = ZERO_HASH
  private path                      = ''
  private buffer:    string[]       = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly outputDir: string) {}

  start(): void {
    mkdirSync(this.outputDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    this.path   = join(this.outputDir, `execution-journal-${ts}.jsonl`)
    this.stream = createWriteStream(this.path, { flags: 'a' })
    this.flushTimer = setInterval(() => this.flush(), 5_000)
    log.info(`[ExecutionJournal] writing → ${this.path}`)
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flush()
    if (this.stream) this.stream.end()
  }

  append(type: string, payload: unknown, actor = 'engine'): JournalEntry {
    const entry: JournalEntry = {
      seq:      this.seq++,
      ts:       Date.now(),
      type,
      actor,
      payload:  redact(payload),
      prevHash: this.prevHash,
      hash:     '',
    }
    entry.hash    = computeHash(entry)
    this.prevHash = entry.hash
    this.buffer.push(JSON.stringify(entry))
    if (this.buffer.length >= 100) this.flush()
    return entry
  }

  getEntryCount(): number { return this.seq }
  getPath():       string { return this.path }

  // ── Internal ────────────────────────────────────────────────────────────────

  private flush(): void {
    if (this.buffer.length === 0 || !this.stream) return
    this.stream.write(this.buffer.join('\n') + '\n')
    this.buffer = []
  }
}

function computeHash(entry: JournalEntry): string {
  const c = JSON.stringify(sortKeys({
    seq:      entry.seq,
    ts:       entry.ts,
    type:     entry.type,
    actor:    entry.actor,
    payload:  entry.payload,
    prevHash: entry.prevHash,
  }))
  return createHash('sha256').update(c).digest('hex')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k])
    return out
  }
  return value
}

// Defense-in-depth: even though SecureSecret.toJSON returns REDACTED, also
// scrub any field name that smells like a secret before serialization.
const SECRET_KEYS = new Set([
  'apiKey', 'apiSecret', 'apiPassphrase', 'privateKey',
  'POLY-API-KEY', 'POLY-PASSPHRASE', 'POLY-SIGNATURE',
])

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o)) {
      if (SECRET_KEYS.has(k)) { out[k] = '[REDACTED]'; continue }
      out[k] = redact(o[k])
    }
    return out
  }
  return value
}
