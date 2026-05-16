import { Pool } from 'pg'
import { config } from '../config/index.js'
import { log } from '../utils/logger.js'

let _pool: Pool | null = null

export function getPool(): Pool {
  if (!_pool) {
    if (!config.dbUrl) throw new Error('[DB] DATABASE_URL is not configured')
    _pool = new Pool({
      connectionString:      config.dbUrl,
      min:                   config.dbPoolMin,
      max:                   config.dbPoolMax,
      idleTimeoutMillis:     30_000,
      connectionTimeoutMillis: 5_000,
    })
    _pool.on('error', (err) => {
      log.error(`[DB] pool error: ${err.message}`)
    })
  }
  return _pool
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}
