'use strict';

/**
 * aiRateLimit.middleware.js (Supabase Production Version)
 */

const { supabase } = require('../config/supabase'); // ✅ REQUIRED
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const MAX_REQUESTS = parseInt(process.env.AI_RATE_LIMIT_MAX || '5', 10);
const WINDOW_S = parseInt(process.env.AI_RATE_LIMIT_WINDOW_S || '60', 10);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _resolveKey(req) {
  const userId = req?.user?.uid ?? req?.user?.id;
  if (!userId) return null;
  return `ai_rate:${userId}`;
}

// Phase 2B.1 — normalized to V2 canonical envelope.
// retryAfter lives in meta.retryAfter (parser reads meta?.retryAfter ?? meta?.retryAfterSeconds).
// Retry-After HTTP header is set separately by the caller for HTTP-level back-off.
function _limitResponse(retryAfterSec) {
  return {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: `Too many AI requests. Please wait ${retryAfterSec} seconds before trying again.`,
    },
    meta: {
      retryAfter: retryAfterSec,
      timestamp: new Date().toISOString(),
    },
  };
}

function _unavailableResponse() {
  return {
    success: false,
    error: {
      code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
      message: 'Rate limiting temporarily unavailable. Please try again shortly.',
    },
    meta: {
      retryAfter: 60,
      timestamp: new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE RPC CALL
// ─────────────────────────────────────────────────────────────────────────────

async function checkRateLimit(key, max, windowSeconds) {
  const { data, error } = await supabase.rpc('check_rate_limit', {
    p_key: key,
    p_limit: max,
    p_window_seconds: windowSeconds,
  });

  if (error) throw error;
  return data === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function aiRateLimit(req, res, next) {
  const key = _resolveKey(req);

  if (!key) {
    logger.error('[aiRateLimit] Missing req.user', { path: req.path });

    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  }

  try {
    const allowed = await checkRateLimit(key, MAX_REQUESTS, WINDOW_S);

    if (!allowed) {
      logger.warn('[aiRateLimit] Rate limit exceeded', {
        key,
        path: req.path,
        method: req.method,
        max: MAX_REQUESTS,
      });

      res.set('Retry-After', String(WINDOW_S));
      return res.status(429).json(_limitResponse(WINDOW_S));
    }

    return next();

  } catch (err) {
    logger.error('[aiRateLimit] Supabase RPC failed', {
      error: err.message,
      key,
    });

    // Production: fail CLOSED — do not let a broken rate-limit service
    // become a free pass for unlimited AI usage.
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json(_unavailableResponse());
    }

    // Dev/test: fail open so local development isn't blocked.
    logger.warn('[aiRateLimit] Failing OPEN (non-production)');
    return next();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM FACTORY
// ─────────────────────────────────────────────────────────────────────────────

function createAiRateLimit({ max = MAX_REQUESTS, windowS = WINDOW_S } = {}) {
  return async function (req, res, next) {
    const key = _resolveKey(req);

    if (!key) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      });
    }

    const scopedKey = `${key}:w${windowS}`;

    try {
      const allowed = await checkRateLimit(scopedKey, max, windowS);

      if (!allowed) {
        res.set('Retry-After', String(windowS));
        return res.status(429).json(_limitResponse(windowS));
      }

      return next();

    } catch (err) {
      logger.error('[aiRateLimit] Custom limiter RPC failed', {
        error: err.message,
        key: scopedKey,
      });

      // Production: fail CLOSED
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json(_unavailableResponse());
      }

      logger.warn('[aiRateLimit] Custom limiter failing OPEN (non-production)');
      return next();
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  aiRateLimit,
  createAiRateLimit,
  MAX_REQUESTS,
  WINDOW_S,
};