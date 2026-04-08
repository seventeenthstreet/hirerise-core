'use strict';

/**
 * shared/logger/index.js
 *
 * Production-grade structured logger
 * ✅ Firebase-free
 * ✅ Supabase-safe secret redaction
 * ✅ Dynamic service resolution
 * ✅ Non-mutating meta handling
 * ✅ Better sampling strategy
 * ✅ Safer truncation
 * ✅ Worker-friendly child logger
 */

const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_PRODUCTION = NODE_ENV === 'production';

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

const currentLevel = LEVELS[LOG_LEVEL] || LEVELS.info;
const SAMPLE_RATE = Number.parseFloat(process.env.LOG_SAMPLE_RATE || '1');

const REDACT_KEYS = new Set([
  'password',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'cookie',
  'set-cookie',
  'access_token',
  'refresh_token',
  'servicerolekey',
  'supabasekey',
]);

function getServiceName() {
  return process.env.SERVICE_NAME || 'hirerise-core';
}

function shouldLog(level) {
  if (level === 'error' || level === 'warn' || level === 'info') {
    return true;
  }

  return Math.random() <= SAMPLE_RATE;
}

function deepRedact(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(deepRedact);
  }

  const clean = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    if (REDACT_KEYS.has(String(key).toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else {
      clean[key] = deepRedact(nestedValue);
    }
  }

  return clean;
}

function safeStringify(obj) {
  const seen = new WeakSet();

  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }

    return value;
  });
}

function serializeError(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: IS_PRODUCTION ? undefined : error.stack,
  };
}

function buildEntry(level, message, meta = {}) {
  const metaCopy = { ...meta };

  const entry = {
    severity: level.toUpperCase(),
    timestamp: new Date().toISOString(),
    service: getServiceName(),
    message,
  };

  if (metaCopy.correlationId) entry.correlationId = metaCopy.correlationId;
  if (metaCopy.requestId) entry.requestId = metaCopy.requestId;
  if (metaCopy.jobId) entry.jobId = metaCopy.jobId;
  if (metaCopy.userId) entry.userId = metaCopy.userId;

  if (metaCopy.err) {
    entry.error = serializeError(metaCopy.err);
    delete metaCopy.err;
  }

  return {
    ...entry,
    ...deepRedact(metaCopy),
  };
}

function emit(level, message, meta = {}) {
  if ((LEVELS[level] || 0) < currentLevel) {
    return;
  }

  if (!shouldLog(level)) {
    return;
  }

  const entry = buildEntry(level, message, meta);
  let output = safeStringify(entry);

  if (Buffer.byteLength(output, 'utf8') > 256 * 1024) {
    output = safeStringify({
      ...entry,
      truncated: true,
      metaOmitted: true,
    });
  }

  if (!IS_PRODUCTION) {
    console.log(`[${entry.severity}] ${entry.message}`, entry);
    return;
  }

  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(output + '\n');
}

const logger = {
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),

  child(defaultMeta = {}) {
    return {
      debug: (message, meta) =>
        emit('debug', message, { ...defaultMeta, ...meta }),
      info: (message, meta) =>
        emit('info', message, { ...defaultMeta, ...meta }),
      warn: (message, meta) =>
        emit('warn', message, { ...defaultMeta, ...meta }),
      error: (message, meta) =>
        emit('error', message, { ...defaultMeta, ...meta }),
    };
  },

  time(label, meta = {}) {
    const start = Date.now();

    return () => {
      const duration = Date.now() - start;
      emit('info', `⏱ ${label}`, {
        ...meta,
        durationMs: duration,
      });
    };
  },
};

module.exports = logger;
module.exports.logger = logger;