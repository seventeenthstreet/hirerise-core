/**
 * logger.js — Centralized Structured Logger (Winston)
 *
 * Scalability note: All log output is structured JSON in production.
 * This makes logs trivially ingestible by CloudWatch, Datadog, GCP Logging,
 * or any log aggregation pipeline without post-processing.
 *
 * Log levels follow RFC 5424: error > warn > info > http > debug
 * In production only error/warn/info are emitted; in dev all levels are.
 */

'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');

const { combine, timestamp, errors, json, colorize, printf } = format;

// ── Human-readable format for development console ──────────────────────────
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n  ${JSON.stringify(meta)}` : '';
    return `${ts} [${level}]: ${stack || message}${metaStr}`;
  })
);

// ── Structured JSON format for production ──────────────────────────────────
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const isProduction = process.env.NODE_ENV === 'production';

const loggerTransports = [
  new transports.Console({
    format:     isProduction ? prodFormat : devFormat,
    handleExceptions: true,
  }),
];

// Write to file only when LOG_FILE_PATH is set (avoids filesystem writes in
// Firebase Functions or read-only container environments)
if (process.env.LOG_FILE_PATH) {
  loggerTransports.push(
    new transports.File({
      filename: path.resolve(process.env.LOG_FILE_PATH),
      format:   prodFormat,
      maxsize:  10 * 1024 * 1024, // 10 MB — rotate before it bloats
      maxFiles: 5,
      tailable: true,
    })
  );
}

const logger = createLogger({
  level:       process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  transports:  loggerTransports,
  exitOnError: false,
});

module.exports = logger;









