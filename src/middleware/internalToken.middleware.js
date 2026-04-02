'use strict';

/**
 * requireInternalToken.middleware.js (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return (
    req.correlationId || // ✅ use correlation middleware first
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomUUID()
  );
}

function extractToken(authHeader) {
  if (!authHeader) return '';

  if (Array.isArray(authHeader)) {
    authHeader = authHeader[0];
  }

  if (typeof authHeader !== 'string') return '';

  return authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';
}

function safeCompare(a, b) {
  try {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');

    if (bufA.length !== bufB.length) return false;

    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// Optional: IP allowlist (comma-separated env)
function isIpAllowed(ip) {
  const allowlist = process.env.INTERNAL_IP_ALLOWLIST;
  if (!allowlist) return true; // disabled

  const allowedIps = allowlist.split(',').map(ip => ip.trim());
  return allowedIps.includes(ip);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

function requireInternalToken(req, res, next) {
  const requestId = getRequestId(req);
  const configuredToken = process.env.INTERNAL_SERVICE_TOKEN;

  // ── Misconfiguration Guard ───────────────────────────────────────
  if (!configuredToken) {
    logger.error('[InternalToken] Missing INTERNAL_SERVICE_TOKEN', {
      requestId,
      path: req.path,
      method: req.method,
    });

    return res.status(503).json({
      success: false,
      error: {
        code: 'SERVICE_MISCONFIGURED',
        message: 'Internal service token not configured.',
      },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Optional IP Allowlist ───────────────────────────────────────
  if (!isIpAllowed(req.ip)) {
    logger.warn('[InternalToken] Blocked IP', {
      requestId,
      ip: req.ip,
      path: req.path,
    });

    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'IP not allowed.',
      },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Extract Token ───────────────────────────────────────────────
  const incoming = extractToken(req.headers.authorization);

  if (!incoming) {
    logger.warn('[InternalToken] Missing token', {
      requestId,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });

    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Internal service token required.',
      },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Validate Token (constant-time) ──────────────────────────────
  const isValid = safeCompare(incoming, configuredToken);

  if (!isValid) {
    logger.warn('[InternalToken] Invalid token attempt', {
      requestId,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });

    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid internal service token.',
      },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Success ────────────────────────────────────────────────────
  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { requireInternalToken };