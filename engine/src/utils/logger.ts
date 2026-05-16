import pino from 'pino'
import { config } from '../config/index'

const isDev = config.nodeEnv !== 'production'

const pinoLogger: pino.Logger = isDev
  ? pino({
      level: config.logLevel,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          destination: 2,
        },
      },
    })
  : pino({ level: config.logLevel }, pino.destination(2))

export { pinoLogger }

export const log = {
  trace: (msg: string, meta?: object) => meta ? pinoLogger.trace(meta, msg) : pinoLogger.trace(msg),
  debug: (msg: string, meta?: object) => meta ? pinoLogger.debug(meta, msg) : pinoLogger.debug(msg),
  info:  (msg: string, meta?: object) => meta ? pinoLogger.info(meta, msg)  : pinoLogger.info(msg),
  warn:  (msg: string, meta?: object) => meta ? pinoLogger.warn(meta, msg)  : pinoLogger.warn(msg),
  error: (msg: string, meta?: object) => meta ? pinoLogger.error(meta, msg) : pinoLogger.error(msg),
  flush: () => pinoLogger.flush(),
}
