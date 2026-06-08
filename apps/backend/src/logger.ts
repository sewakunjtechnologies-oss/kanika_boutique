import pino from 'pino';
import { env } from './config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

export function botLog(event: string, data: Record<string, unknown> = {}, debugOnly = false): void {
  if (debugOnly && !env.CHATBOT_DEBUG) return;
  logger.info({ event, ...data }, event);
}

export function botError(event: string, err: unknown, data: Record<string, unknown> = {}): void {
  logger.error(
    {
      event,
      ...data,
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    },
    event,
  );
}
