'use strict';

const { createLogger, format, transports, addColors } = require('winston');
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

// ── PATCH: Add 'fatal' level above 'error' ────────────────────────────────────
// Winston's default npm levels go: error(0) warn(1) info(2) ...
// We add fatal(0) above error by shifting the numeric priority convention:
// fatal=0, error=1, warn=2, info=3, http=4, verbose=5, debug=6, silly=7
// This means fatal(0) ALWAYS prints regardless of LOG_LEVEL.
const CUSTOM_LEVELS = {
  levels: {
    fatal:   0,
    error:   1,
    warn:    2,
    info:    3,
    http:    4,
    verbose: 5,
    debug:   6,
    silly:   7,
  },
  colors: {
    fatal:   'bold red',
    error:   'red',
    warn:    'yellow',
    info:    'green',
    http:    'magenta',
    verbose: 'cyan',
    debug:   'blue',
    silly:   'grey',
  },
};

addColors(CUSTOM_LEVELS.colors);
// ── END PATCH ─────────────────────────────────────────────────────────────────

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
    // PATCH: fatal also goes to stderr so Cloud Run / Docker operators
    // see it on the error stream, not buried in stdout.
    stderrLevels: ['fatal', 'error'],
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
  // PATCH: use custom levels that include 'fatal'
  levels: CUSTOM_LEVELS.levels,
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