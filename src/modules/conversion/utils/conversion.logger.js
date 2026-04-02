'use strict';

/**
 * src/modules/conversion/utils/conversion.logger.js
 *
 * Scoped logger wrapper for the Conversion module.
 *
 * Features:
 * - safe shared logger resolution
 * - supports Winston / Pino / Bunyan / custom logger
 * - console fallback
 * - circular-safe metadata normalization
 * - bounded metadata size
 * - never throws
 * - production-safe debug/trace support
 */

let baseLogger = null;

const LOGGER_CANDIDATE_PATHS = [
  '../../../utils/logger',
  '../../../shared/logger',
  '../../../../shared/logger',
];

for (const path of LOGGER_CANDIDATE_PATHS) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    baseLogger = require(path);
    break;
  } catch {
    // try next candidate
  }
}

if (!baseLogger) {
  baseLogger = console;
}

const PREFIX = '[conversion]';
const MAX_META_KEYS = 50;

/**
 * Resolve logger method safely.
 *
 * @param {string} method
 * @returns {(message:string, meta?:object)=>void}
 */
function resolveMethod(method) {
  if (baseLogger && typeof baseLogger[method] === 'function') {
    return baseLogger[method].bind(baseLogger);
  }

  if (typeof console[method] === 'function') {
    return console[method].bind(console);
  }

  return console.log.bind(console);
}

/**
 * Prevent logging crashes from circular or huge metadata.
 *
 * @param {unknown} meta
 * @returns {Record<string, unknown>}
 */
function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return {};
  }

  try {
    const entries = Object.entries(meta).slice(0, MAX_META_KEYS);
    const bounded = Object.fromEntries(entries);

    JSON.stringify(bounded);

    return bounded;
  } catch {
    return { note: 'meta_unserializable' };
  }
}

/**
 * Standardized log execution.
 *
 * @param {'info'|'warn'|'error'|'debug'|'trace'} method
 * @param {string} message
 * @param {object} meta
 */
function log(method, message, meta = {}) {
  try {
    const logMethod = resolveMethod(method);
    const normalizedMeta = safeMeta(meta);

    logMethod(`${PREFIX} ${message}`, {
      timestamp: new Date().toISOString(),
      ...normalizedMeta,
    });
  } catch (error) {
    // absolute safety fallback
    console.error('[conversion] logger failure', {
      timestamp: new Date().toISOString(),
      originalMessage: message,
      error: error.message,
    });
  }
}

const logger = Object.freeze({
  /**
   * Informational lifecycle events
   */
  info(message, meta = {}) {
    log('info', message, meta);
  },

  /**
   * Recoverable warnings
   */
  warn(message, meta = {}) {
    log('warn', message, meta);
  },

  /**
   * Unexpected failures
   */
  error(message, meta = {}) {
    log('error', message, meta);
  },

  /**
   * Debug logs
   */
  debug(message, meta = {}) {
    log('debug', message, meta);
  },

  /**
   * Ultra-verbose trace logs
   */
  trace(message, meta = {}) {
    log('trace', message, meta);
  },
});

module.exports = logger;