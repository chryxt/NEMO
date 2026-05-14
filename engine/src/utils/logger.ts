const LEVEL = (process.env['LOG_LEVEL'] ?? 'info') as 'debug' | 'info' | 'warn' | 'error'

const levels = { debug: 0, info: 1, warn: 2, error: 3 }
const current = levels[LEVEL] ?? 1

function ts(): string {
  return new Date().toISOString().slice(11, 23)  // HH:mm:ss.mmm
}

export const log = {
  debug: (msg: string) => { if (current <= 0) process.stderr.write(`[${ts()}] DBG  ${msg}\n`) },
  info:  (msg: string) => { if (current <= 1) process.stderr.write(`[${ts()}] INFO ${msg}\n`) },
  warn:  (msg: string) => { if (current <= 2) process.stderr.write(`[${ts()}] WARN ${msg}\n`) },
  error: (msg: string) => { if (current <= 3) process.stderr.write(`[${ts()}] ERR  ${msg}\n`) },
}
