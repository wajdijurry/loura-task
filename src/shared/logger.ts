import pino, { type Logger, type LoggerOptions } from 'pino';

const REDACT_PATHS = [
  'DATABASE_URL',
  'req.headers.authorization',
  'password',
  'subject',
  'body',
  'rawOutput',
  'modelOutput',
  'prompt',
  '*.subject',
  '*.body',
  '*.rawOutput',
  '*.modelOutput',
];

export function createLogger(options: { level?: string; name?: string; pretty?: boolean }): Logger {
  const opts: LoggerOptions = {
    name: options.name,
    level: options.level ?? 'info',
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    base: {
      service: options.name,
    },
  };

  if (options.pretty) {
    return pino({
      ...opts,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
    });
  }

  return pino(opts);
}
