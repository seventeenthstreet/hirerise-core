'use strict';

/**
 * conversion.logger.js
 *
 * Scoped logger wrapper for the Conversion module.
 *
 * - Uses shared app logger if available (Winston / Pino / Bunyan).
 * - Falls back safely to console in development.
 * - Never throws if logger methods are missing.
 * - Normalizes metadata to prevent logging crashes.
 *
 * To swap logger implementation:
 *   Change only the baseLogger resolution block below.
 */

let baseLogger;

/**
 * Resolve shared logger safely.
 */
try {
  // Adjust this path to match your app structure.
  baseLogger = require('../../../../shared/logger');
} catch {
  baseLogger = console;
}

const PREFIX = '[conversion]';

/**
 * Ensure logger method exists.
 */
function _resolveMethod(method) {
  if (baseLogger && typeof baseLogger[method] === 'function') {
    return baseLogger[method].bind(baseLogger);
  }

  // Fallback hierarchy
  if (typeof console[method] === 'function') {
    return console[method].bind(console);
  }

  return console.log.bind(console);
}

/**
 * Prevent logging from crashing due to circular references.
 */
function _safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};

  try {
    JSON.stringify(meta);
    return meta;
  } catch {
    return { note: 'meta_unserializable' };
  }
}

/**
 * Standardized log execution.
 */
function _log(method, message, meta) {
  try {
    const logMethod = _resolveMethod(method);
    const normalizedMeta = _safeMeta(meta);

    logMethod(`${PREFIX} ${message}`, normalizedMeta);
  } catch (err) {
    // Absolute safety fallback — logging must never crash app
    console.error('[conversion] logger failure', {
      originalMessage: message,
      error: err.message,
    });
  }
}

const logger = {
  /**
   * Informational logs (non-error lifecycle events)
   */
  info(message, meta = {}) {
    _log('info', message, meta);
  },

  /**
   * Warnings (non-fatal recoverable issues)
   */
  warn(message, meta = {}) {
    _log('warn', message, meta);
  },

  /**
   * Errors (unexpected runtime failures)
   */
  error(message, meta = {}) {
    _log('error', message, meta);
  },

  /**
   * Debug logs (should be filtered in production)
   */
  debug(message, meta = {}) {
    _log('debug', message, meta);
  },
};

module.exports = logger;