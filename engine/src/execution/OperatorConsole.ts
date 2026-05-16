/**
 * Operator console — Unix-socket based command interface.
 *
 * Operators connect with `nc -U /tmp/nemo-execution.sock` and issue
 * commands. Lightweight by design — no web UI, no auth (the socket lives
 * on the local filesystem, so OS-level perms gate access).
 *
 * Supported commands:
 *   STATUS                          — gateway + halt + daily notional
 *   LIST PENDING                    — pending approvals from shadow queue
 *   LIST RECENT                     — recent gateway decisions
 *   APPROVE <id> <reason>           — approve a pending shadow order
 *   REJECT  <id> <reason>           — reject a pending shadow order
 *   HALT    <reason>                — emergency halt (one-way)
 *   QUIT                            — disconnect
 *
 * Notes:
 *   - RESUME is intentionally NOT supported in this phase.
 *   - Every accepted command is journaled via the supplied callback.
 *   - Each socket connection prompts for operator identity on first line.
 */
import { createServer, Socket } from 'net'
import type { Server } from 'net'
import { log } from '../utils/logger'
import type { ApprovalQueue } from '../shadow/ApprovalQueue'
import type { EmergencyHalt } from './EmergencyHalt'
import type { OperatorAction } from './types'

export interface OperatorConsoleCallbacks {
  getStatusText:     () => string
  getRecentDecisions:() => string
  onOperatorAction:  (action: OperatorAction) => void
}

export class OperatorConsole {
  private server: Server | null = null
  private connections = new Set<Socket>()

  constructor(
    private readonly socketPath: string,
    private readonly approval:   ApprovalQueue,
    private readonly halt:       EmergencyHalt,
    private readonly cbs:        OperatorConsoleCallbacks,
  ) {}

  start(): void {
    if (!this.socketPath) return
    try {
      // Remove stale socket file if present
      try { require('fs').unlinkSync(this.socketPath) } catch { /* not present */ }
    } catch { /* ignore */ }

    this.server = createServer((socket) => this.handle(socket))
    this.server.on('error', (err) => log.error(`[OperatorConsole] server error: ${err.message}`))
    this.server.listen(this.socketPath, () => {
      log.info(`[OperatorConsole] listening on ${this.socketPath} — connect with: nc -U ${this.socketPath}`)
    })
  }

  stop(): void {
    for (const c of this.connections) c.destroy()
    this.connections.clear()
    if (this.server) this.server.close()
  }

  private handle(socket: Socket): void {
    this.connections.add(socket)
    socket.on('close', () => this.connections.delete(socket))
    socket.write('NEMO execution operator console\n')
    socket.write('Type your operator identity then ENTER, or QUIT.\n')

    let operator: string | null = null
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)

        if (!operator) {
          if (!line || /^quit$/i.test(line)) { socket.end(); return }
          operator = line.slice(0, 40)
          socket.write(`hello ${operator}. Commands: STATUS | LIST PENDING | LIST RECENT | APPROVE <id> <reason> | REJECT <id> <reason> | HALT <reason> | QUIT\n> `)
          continue
        }
        this.dispatch(socket, operator, line)
        socket.write('> ')
      }
    })
  }

  private dispatch(socket: Socket, operator: string, line: string): void {
    const upper = line.toUpperCase()
    const ts = Date.now()
    if (upper === 'QUIT') { socket.end(); return }

    if (upper === 'STATUS') {
      socket.write(this.cbs.getStatusText() + '\n')
      this.cbs.onOperatorAction({ ts, operator, command: 'STATUS', payload: {}, result: 'accepted', reason: null })
      return
    }
    if (upper === 'LIST PENDING') {
      const pending = this.approval.getPending()
      socket.write(`pending: ${pending.length}\n`)
      for (const p of pending) {
        socket.write(`  ${p.id} notional=$${p.order.notionalUsd.toFixed(2)} ${p.order.symbol} ${p.order.outcome} ${p.order.side}\n`)
      }
      this.cbs.onOperatorAction({ ts, operator, command: 'LIST PENDING', payload: { count: pending.length }, result: 'accepted', reason: null })
      return
    }
    if (upper === 'LIST RECENT') {
      socket.write(this.cbs.getRecentDecisions() + '\n')
      this.cbs.onOperatorAction({ ts, operator, command: 'LIST RECENT', payload: {}, result: 'accepted', reason: null })
      return
    }
    const approveMatch = line.match(/^APPROVE\s+(\S+)\s+(.+)$/i)
    if (approveMatch) {
      const [, id, reason] = approveMatch
      const ok = this.approval.decide(id!, true, operator, reason!)
      socket.write(ok ? `approved ${id}\n` : `cannot approve ${id} (not pending)\n`)
      this.cbs.onOperatorAction({
        ts, operator, command: 'APPROVE',
        payload: { id, reason },
        result: ok ? 'accepted' : 'rejected',
        reason: ok ? null : 'not pending',
      })
      return
    }
    const rejectMatch = line.match(/^REJECT\s+(\S+)\s+(.+)$/i)
    if (rejectMatch) {
      const [, id, reason] = rejectMatch
      const ok = this.approval.decide(id!, false, operator, reason!)
      socket.write(ok ? `rejected ${id}\n` : `cannot reject ${id} (not pending)\n`)
      this.cbs.onOperatorAction({
        ts, operator, command: 'REJECT',
        payload: { id, reason },
        result: ok ? 'accepted' : 'rejected',
        reason: ok ? null : 'not pending',
      })
      return
    }
    const haltMatch = line.match(/^HALT\s+(.+)$/i)
    if (haltMatch) {
      const [, reason] = haltMatch
      this.halt.trigger('operator-console', `${operator}: ${reason}`)
      socket.write(`HALT activated by ${operator}\n`)
      this.cbs.onOperatorAction({ ts, operator, command: 'HALT', payload: { reason }, result: 'accepted', reason: null })
      return
    }

    socket.write('unknown command\n')
    this.cbs.onOperatorAction({ ts, operator, command: line, payload: {}, result: 'rejected', reason: 'unknown command' })
  }
}
