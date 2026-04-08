'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');

const {
  combine,
  timestamp,
  errors,
  json,
  colorize,
  printf,
  splat,
} = format;

const isProduction = process.env.NODE_ENV === 'production';
const defaultLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

// ─────────────────────────────────────────────
// Safe metadata serializer
// ─────────────────────────────────────────────

function safeStringify(meta) {
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return '[unserializable metadata]';
  }
}

// ─────────────────────────────────────────────
// Dev console format
// ─────────────────────────────────────────────

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  splat(),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr =
      Object.keys(meta).length > 0
        ? `\n${safeStringify(meta)}`
        : '';

    return `${ts} [${level}]: ${stack || message}${metaStr}`;
  })
);

// ─────────────────────────────────────────────
// Production JSON format
// ─────────────────────────────────────────────

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  splat(),
  json()
);

// ─────────────────────────────────────────────
// Transports
// ─────────────────────────────────────────────

const loggerTransports = [
  new transports.Console({
    format: isProduction ? prodFormat : devFormat,
    handleExceptions: true,
    stderrLevels: ['error'],
  }),
];

if (process.env.LOG_FILE_PATH) {
  loggerTransports.push(
    new transports.File({
      filename: path.resolve(process.env.LOG_FILE_PATH),
      format: prodFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
      handleExceptions: true,
    })
  );
}

// ─────────────────────────────────────────────
// Logger instance
// ─────────────────────────────────────────────

const logger = createLogger({
  level: defaultLevel,
  transports: loggerTransports,
  exitOnError: false,
  defaultMeta: {
    service: 'hirerise-core',
    environment: process.env.NODE_ENV || 'development',
  },
});

/**
 * Create child logger with request/job context.
 *
 * @param {object} meta
 * @returns {import('winston').Logger}
 */
logger.childLogger = function childLogger(meta = {}) {
  return logger.child(meta);
};

module.exports = logger;