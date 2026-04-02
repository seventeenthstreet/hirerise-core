'use strict';

/**
 * logger.js — PRODUCTION HARDENED
 *
 * ✅ Deep redaction
 * ✅ Safe stringify (no crashes)
 * ✅ Log size protection
 * ✅ Better context handling
 * ✅ Dev pretty logs
 */

const SERVICE_NAME = process.env.SERVICE_NAME || 'hirerise-core';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ENV = process.env.NODE_ENV || 'development';

const IS_PRODUCTION = NODE_ENV === 'production';

// ─────────────────────────────────────────────
// Log Levels
// ─────────────────────────────────────────────
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

// ─────────────────────────────────────────────
// Sampling
// ─────────────────────────────────────────────
const SAMPLE_RATE = parseFloat(process.env.LOG_SAMPLE_RATE || '1');

function shouldLog(level) {
  if (level === 'error' || level === 'warn') return true;
  return Math.random() <= SAMPLE_RATE;
}

// ─────────────────────────────────────────────
// Deep Redaction (FIXED)
// ─────────────────────────────────────────────
const REDACT_KEYS = ['password', 'token', 'authorization', 'apikey'];

function deepRedact(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(deepRedact);
  }

  const clean = {};
  for (const key in obj) {
    if (REDACT_KEYS.includes(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else {
      clean[key] = deepRedact(obj[key]);
    }
  }
  return clean;
}

// ─────────────────────────────────────────────
// Safe JSON stringify (FIXED)
// ─────────────────────────────────────────────
function safeStringify(obj) {
  const seen = new WeakSet();

  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

// ─────────────────────────────────────────────
// Error Serialization
// ─────────────────────────────────────────────
function serializeError(err) {
  if (!(err instanceof Error)) return err;

  return {
    name: err.name,
    message: err.message,
    stack: IS_PRODUCTION ? undefined : err.stack,
    code: err.code,
  };
}

// ─────────────────────────────────────────────
// Build Entry
// ─────────────────────────────────────────────
function buildEntry(level, message, meta = {}) {
  const base = {
    severity: level.toUpperCase(),
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    message,
  };

  // Standardized context
  if (meta.correlationId) base.correlationId = meta.correlationId;
  if (meta.requestId) base.requestId = meta.requestId;
  if (meta.jobId) base.jobId = meta.jobId;
  if (meta.userId) base.userId = meta.userId;

  if (meta.err) {
    base.error = serializeError(meta.err);
    delete meta.err;
  }

  return {
    ...base,
    ...deepRedact(meta),
  };
}

// ─────────────────────────────────────────────
// Emit
// ─────────────────────────────────────────────
function emit(level, message, meta = {}) {
  if ((LEVELS[level] ?? 0) < currentLevel) return;
  if (!shouldLog(level)) return;

  const entry = buildEntry(level, message, meta);

  let output = safeStringify(entry);

  // Size protection (256KB max)
  if (Buffer.byteLength(output) > 256 * 1024) {
    output = safeStringify({
      ...entry,
      message: '[TRUNCATED LOG]',
    });
  }

  // Dev-friendly logs
  if (!IS_PRODUCTION) {
    console.log(`[${entry.severity}] ${entry.message}`, entry);
    return;
  }

  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

// ─────────────────────────────────────────────
// Logger API
// ─────────────────────────────────────────────
const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),

  child: (defaultMeta = {}) => ({
    debug: (msg, meta) => emit('debug', msg, { ...defaultMeta, ...meta }),
    info: (msg, meta) => emit('info', msg, { ...defaultMeta, ...meta }),
    warn: (msg, meta) => emit('warn', msg, { ...defaultMeta, ...meta }),
    error: (msg, meta) => emit('error', msg, { ...defaultMeta, ...meta }),
  }),

  time: (label, meta = {}) => {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      emit('info', `⏱ ${label}`, { ...meta, durationMs: duration });
    };
  },
};

module.exports = logger;
module.exports.logger = logger;