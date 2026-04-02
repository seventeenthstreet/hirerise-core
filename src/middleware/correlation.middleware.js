'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * correlation.middleware.js (Production Optimized)
 */

const HEADER_NAME = 'X-Correlation-ID';
const MAX_LENGTH = 128;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function isValidCorrelationId(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.length > MAX_LENGTH) return false;

  // allow uuid, trace ids, safe chars
  return /^[a-zA-Z0-9\-_.]+$/.test(value);
}

function extractTraceId(traceparent) {
  // W3C format: version-traceid-spanid-flags
  if (!traceparent || typeof traceparent !== 'string') return null;

  const parts = traceparent.split('-');
  if (parts.length !== 4) return null;

  return parts[1]; // trace-id
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const correlationMiddleware = (req, res, next) => {
  try {
    let incoming =
      req.headers['x-correlation-id'] ||
      req.headers['x-request-id'];

    // Prefer traceparent if valid
    if (!incoming && req.headers['traceparent']) {
      incoming = extractTraceId(req.headers['traceparent']);
    }

    const correlationId =
      (incoming && isValidCorrelationId(incoming))
        ? incoming
        : uuidv4();

    // Attach to request
    req.correlationId = correlationId;

    // Attach to response header
    res.setHeader(HEADER_NAME, correlationId);

    // Optional: attach to res.locals for templating/logging systems
    res.locals.correlationId = correlationId;

    return next();

  } catch (err) {
    // Absolute fallback (never break request flow)
    const fallbackId = uuidv4();

    req.correlationId = fallbackId;
    res.setHeader(HEADER_NAME, fallbackId);

    return next();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { correlationMiddleware };