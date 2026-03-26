'use strict';

/**
 * aiRateLimit.middleware.js — Per-User AI Endpoint Rate Limiter
 * =============================================================
 *
 * SECURITY CHANGES (remediation):
 *   SEC-CRIT-04: Fail CLOSED on Redis/storage error.
 *     Previously failed open — a Redis outage disabled all AI rate limiting,
 *     creating an unlimited-cost window. Now returns 503 on any error.
 *   SEC-LOW-03: Removed IP-based fallback key.
 *     All AI endpoints require authentication. An unauthenticated request
 *     cannot reach here legitimately. Returns 401 if req.user is missing.
 *   SEC-MED-01: Error envelope updated to { success, error: { code, message } }.
 *
 * LAYERS:
 *   Layer 1 → tierQuota      — monthly AI usage quota by tier
 *   Layer 2 → creditGuard    — per-operation credit balance check
 *   Layer 3 → aiRateLimit    — per-user burst protection (this file)
 *   Layer 4 → deductCredits  — atomic Firestore credit deduction
 *
 * STORAGE:
 *   Primary:  Redis sorted-set sliding window.
 *   Fallback: In-memory Map — ONLY when Redis is null at startup.
 *             Runtime Redis errors always fail CLOSED (503).
 */

const logger = require('../utils/logger');
const redis  = require('../../shared/redis.client');

const MAX_REQUESTS = parseInt(process.env.AI_RATE_LIMIT_MAX      || '5',  10);
const WINDOW_MS    = parseInt(process.env.AI_RATE_LIMIT_WINDOW_S || '60', 10) * 1000;
const WINDOW_S     = Math.ceil(WINDOW_MS / 1000);

// ── In-memory fallback store ──────────────────────────────────────────────────
const _store = new Map();

const _evictInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of _store.entries()) {
    const fresh = timestamps.filter(t => now - t < WINDOW_MS);
    if (fresh.length === 0) _store.delete(key);
    else _store.set(key, fresh);
  }
}, 5 * 60 * 1000);
_evictInterval.unref();

// ── Key resolution — user-only, NO IP fallback ────────────────────────────────
function _resolveKey(req) {
  const userId = req?.user?.uid ?? req?.user?.id;
  if (!userId) return null;
  return `ai_rate:user:${userId}`;
}

// ── Redis sliding-window check ────────────────────────────────────────────────
async function _checkRedis(key) {
  const now  = Date.now();
  const pipe = redis.pipeline();
  pipe.zadd(key, now, String(now));
  pipe.zremrangebyscore(key, 0, now - WINDOW_MS);
  pipe.zcard(key);
  pipe.expire(key, WINDOW_S + 1);
  const results = await pipe.exec();
  const err = results.find(r => r[0]);
  if (err) throw err[0];
  return { count: results[2][1], now };
}

// ── In-memory sliding-window check ───────────────────────────────────────────
function _checkMemory(key) {
  const now        = Date.now();
  const timestamps = (_store.get(key) || []).filter(t => now - t < WINDOW_MS);
  const count      = timestamps.length;
  timestamps.push(now);
  _store.set(key, timestamps);
  return { count, now };
}

// ── Standard error responses ──────────────────────────────────────────────────
function _limitResponse(retryAfterSec) {
  return {
    success: false,
    error: {
      code:    'RATE_LIMITED',
      message: `Too many AI requests. Please wait ${retryAfterSec} seconds before trying again.`,
    },
    retryAfterSeconds: retryAfterSec,
    timestamp:         new Date().toISOString(),
  };
}

function _unavailableResponse() {
  return {
    success: false,
    error: {
      code:    'RATE_LIMIT_SERVICE_UNAVAILABLE',
      message: 'Rate limiting service is temporarily unavailable. Please try again shortly.',
    },
  };
}

// ── Main middleware ───────────────────────────────────────────────────────────
async function aiRateLimit(req, res, next) {
  const key = _resolveKey(req);

  if (!key) {
    logger.error('[aiRateLimit] req.user missing — authenticate must run first', { path: req.path });
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  }

  try {
    if (redis) {
      const { count } = await _checkRedis(key);
      if (count > MAX_REQUESTS) {
        logger.warn('[aiRateLimit] Rate limit hit', { key, count, max: MAX_REQUESTS, path: req.path });
        return res.status(429).json(_limitResponse(WINDOW_S));
      }
    } else {
      logger.warn('[aiRateLimit] Redis not configured — in-memory fallback active. Set CACHE_PROVIDER=redis.', { key });
      const { count } = _checkMemory(key);
      if (count >= MAX_REQUESTS) {
        logger.warn('[aiRateLimit] Rate limit hit (in-memory)', { key, count, max: MAX_REQUESTS, path: req.path });
        return res.status(429).json(_limitResponse(WINDOW_S));
      }
    }
  } catch (err) {
    // CRIT-04 FIX: Fail CLOSED — never allow unlimited AI calls on rate-limit failure.
    logger.error('[aiRateLimit] Rate limit check failed — failing CLOSED (503)', {
      key, error: err.message, path: req.path,
    });
    return res.status(503).json(_unavailableResponse());
  }

  return next();
}

// ── Factory for custom per-endpoint limits ────────────────────────────────────
function createAiRateLimit({ max = MAX_REQUESTS, windowS = WINDOW_S } = {}) {
  const windowMs = windowS * 1000;

  return async function customAiRateLimit(req, res, next) {
    const key = _resolveKey(req);
    if (!key) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      });
    }

    const scopedKey = `${key}:w${windowS}`;

    try {
      if (redis) {
        const now  = Date.now();
        const pipe = redis.pipeline();
        pipe.zadd(scopedKey, now, String(now));
        pipe.zremrangebyscore(scopedKey, 0, now - windowMs);
        pipe.zcard(scopedKey);
        pipe.expire(scopedKey, windowS + 1);
        const results = await pipe.exec();
        const pipeErr = results.find(r => r[0]);
        if (pipeErr) throw pipeErr[0];
        if (results[2][1] > max) {
          logger.warn('[aiRateLimit] Custom rate limit hit', { key: scopedKey, max, path: req.path });
          return res.status(429).json(_limitResponse(windowS));
        }
      } else {
        const { count } = _checkMemory(scopedKey);
        if (count >= max) {
          return res.status(429).json(_limitResponse(windowS));
        }
      }
    } catch (err) {
      logger.error('[aiRateLimit] Custom rate limit failed — failing CLOSED (503)', {
        key: scopedKey, error: err.message, path: req.path,
      });
      return res.status(503).json(_unavailableResponse());
    }

    return next();
  };
}

module.exports = {
  aiRateLimit,
  createAiRateLimit,
  _store,
  _resolveKey,
  MAX_REQUESTS,
  WINDOW_MS,
};








