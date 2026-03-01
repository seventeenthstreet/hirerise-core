import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const SERVICE_NAME = process.env.SERVICE_NAME || 'hirerise-unknown';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function buildEntry(level, message, meta = {}) {
  return {
    severity: level.toUpperCase(),
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    message,
    ...meta,
    ...(meta.err instanceof Error
      ? {
          error: {
            name: meta.err.name,
            message: meta.err.message,
            stack: IS_PRODUCTION ? undefined : meta.err.stack,
            code: meta.err.code,
          },
        }
      : {}),
  };
}

function emit(level, message, meta = {}) {
  if ((LEVELS[level] ?? 0) < currentLevel) return;
  const entry = buildEntry(level, message, meta);
  const output = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

export const logger = {
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
  child: (defaultMeta) => ({
    debug: (message, meta) => emit('debug', message, { ...defaultMeta, ...meta }),
    info: (message, meta) => emit('info', message, { ...defaultMeta, ...meta }),
    warn: (message, meta) => emit('warn', message, { ...defaultMeta, ...meta }),
    error: (message, meta) => emit('error', message, { ...defaultMeta, ...meta }),
  }),
};
