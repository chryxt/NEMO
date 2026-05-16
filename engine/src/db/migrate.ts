import { readFileSync } from 'fs'
import { join } from 'path'
import { getPool } from './pool'
import { log } from '../utils/logger'

// __dirname resolves to engine/src/db in dev (ts-node) and engine/dist/db in prod.
// Going two levels up always lands at engine/ in both cases.
const SQL_PATH = join(__dirname, '..', '..', 'migrations', '001_initial.sql')

export async function runMigration(): Promise<void> {
  const sql = readFileSync(SQL_PATH, 'utf8')
  const pool = getPool()
  log.info('[DB] running schema migration...')
  const client = await pool.connect()
  try {
    await client.query(sql)
    log.info('[DB] migration applied successfully')
  } finally {
    client.release()
  }
}
