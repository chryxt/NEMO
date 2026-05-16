/**
 * Append-only, hash-chained audit log for shadow-execution activity.
 *
 * Each line is a JSON object with:
 *   - seq      : monotonic counter
 *   - ts       : wall-clock (Date.now())
 *   - type     : event kind
 *   - actor    : 'engine' or operator label
 *   - payload  : arbitrary JSON
 *   - prevHash : hash of previous entry (or 64 zeros for entry 0)
 *   - hash     : SHA-256(prevHash + canonical(payload + seq + type + actor + ts))
 *
 * Tamper detection: any retroactive edit breaks the chain because subsequent
 * hashes will not match. `verify()` walks the file and reports the first
 * inconsistent line.
 */
import { createHash } from 'crypto'
import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'fs'
import type { WriteStream } from 'fs'
import { join } from 'path'
import { log } from '../utils/logger.js'
import type { AuditEntry } from './types.js'

const ZERO_HASH = '0'.repeat(64)

export class AuditLog {
  private stream:    WriteStream | null = null
  private seq                          = 0
  private prevHash:  string            = ZERO_HASH
  private path                         = ''
  private buffer:    string[]          = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly outputDir: string) {}

  start(): void {
    mkdirSync(this.outputDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    this.path   = join(this.outputDir, `audit-${ts}.jsonl`)
    this.stream = createWriteStream(this.path, { flags: 'a' })
    this.flushTimer = setInterval(() => this.flush(), 5_000)
    log.info(`[AuditLog] writing → ${this.path}`)
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flush()
    if (this.stream) this.stream.end()
  }

  /** Append an audit entry — computes the hash chain entry. */
  append(type: string, payload: unknown, actor = 'engine'): AuditEntry {
    const entry: AuditEntry = {
      seq:      this.seq++,
      ts:       Date.now(),
      type,
      actor,
      payload,
      prevHash: this.prevHash,
      hash:     '',
    }
    entry.hash = computeHash(entry)
    this.prevHash = entry.hash
    this.buffer.push(JSON.stringify(entry))
    if (this.buffer.length >= 200) this.flush()
    return entry
  }

  getEntryCount(): number { return this.seq }

  getPath(): string { return this.path }

  // Static verification utility — checks an existing file
  static verify(path: string): { ok: boolean; brokenAt: number | null; reason: string | null } {
    if (!existsSync(path)) return { ok: false, brokenAt: null, reason: 'file not found' }
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
    let prev = ZERO_HASH
    for (let i = 0; i < lines.length; i++) {
      let entry: AuditEntry
      try { entry = JSON.parse(lines[i]!) as AuditEntry }
      catch (err) { return { ok: false, brokenAt: i, reason: `parse failed: ${(err as Error).message}` } }
      if (entry.prevHash !== prev) {
        return { ok: false, brokenAt: i, reason: `prevHash mismatch at seq=${entry.seq}` }
      }
      const expected = computeHash(entry)
      if (entry.hash !== expected) {
        return { ok: false, brokenAt: i, reason: `hash mismatch at seq=${entry.seq}` }
      }
      prev = entry.hash
    }
    return { ok: true, brokenAt: null, reason: null }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private flush(): void {
    if (this.buffer.length === 0 || !this.stream) return
    this.stream.write(this.buffer.join('\n') + '\n')
    this.buffer = []
  }
}

function computeHash(entry: AuditEntry): string {
  const canonical = canonicalize({
    seq:      entry.seq,
    ts:       entry.ts,
    type:     entry.type,
    actor:    entry.actor,
    payload:  entry.payload,
    prevHash: entry.prevHash,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function canonicalize(value: unknown): string {
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
