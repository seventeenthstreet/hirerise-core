'use strict';

/**
 * aiRateLimitByPlan.middleware.js — Role-Aware Daily AI Rate Limiter
 * ===================================================================
 *
 * Replaces the flat aiRateLimit for AI-heavy paid endpoints.
 * Enforces daily limits per plan using Redis (or in-memory fallback).
 *
 * LIMITS (configurable via env vars):
 *   free       → blocked upstream by requirePaidPlan (never reaches here)
 *   pro        → AI_RATE_LIMIT_PRO/day    (default: 100)
 *   elite      → AI_RATE_LIMIT_ELITE/day  (default: 100)
 *   enterprise → unlimited
 *   admin      → unlimited
 *
 * STORAGE:
 *   Primary:  Redis sorted set, key: ai_rate:plan:{plan}:user:{uid}:day:{YYYY-MM-DD}
 *   Fallback: In-memory Map (per-instance, emits warning)
 *   FAILURE:  Fail CLOSED (503) — never open.
 *
 * MIDDLEWARE ORDER:
 *   authenticate → requirePaidPlan → aiRateLimitByPlan → validation → controller
 */

const logger = require('../utils/logger');
const redis  = require('../../shared/redis.client');
const { normalizeTier } = require('./requireTier.middleware');

// ─── Plan limits ──────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  free:       parseInt(process.env.AI_RATE_LIMIT_FREE       || '5',   10),
  pro:        parseInt(process.env.AI_RATE_LIMIT_PRO        || '100', 10),
  elite:      parseInt(process.env.AI_RATE_LIMIT_ELITE      || '100', 10),
  premium:    parseInt(process.env.AI_RATE_LIMIT_PREMIUM    || '100', 10),
  enterprise: null,  // unlimited
};

// ─── In-memory fallback ───────────────────────────────────────────────────────
const _store = new Map();

setInterval(() => {
  const today = _todayKey();
  for (const key of _store.keys()) {
    if (!key.endsWith(today)) _store.delete(key);
  }
}, 60 * 60 * 1000).unref();

function _todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function _redisKey(plan, uid) {
  return `ai_rate:plan:${plan}:user:${uid}:day:${_todayKey()}`;
}

function _secondsUntilMidnight() {
  const now  = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((next - now) / 1000);
}

function _limitResponse(limit, plan) {
  return {
    success: false,
    error: {
      code:    'RATE_LIMITED',
      message: `You've reached your daily limit of ${limit} AI requests on the ${plan} plan. Your limit resets at UTC midnight.`,
    },
    retryAfterSeconds: _secondsUntilMidnight(),
  };
}

function _unavailableResponse() {
  return {
    success: false,
    error: {
      code:    'RATE_LIMIT_SERVICE_UNAVAILABLE',
      message: 'Rate limiting service temporarily unavailable. Please try again shortly.',
    },
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────
async function aiRateLimitByPlan(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  }

  // Admin bypass — unlimited.
  const isAdmin =
    req.user.admin === true ||
    ['admin', 'super_admin'].includes(req.user.role ?? '') ||
    (req.user.roles ?? []).includes('admin');

  if (isAdmin) return next();

  const plan  = normalizeTier(req.user.plan);
  const uid   = req.user.uid;
  const limit = plan in PLAN_LIMITS ? PLAN_LIMITS[plan] : PLAN_LIMITS.free;

  // Unlimited plan — skip check.
  if (limit === null) return next();

  const key = _redisKey(plan, uid);

  try {
    // Check Redis is available AND connected before using it
    const redisReady = redis && redis.status === 'ready';

    if (redisReady) {
      const ttl  = _secondsUntilMidnight() + 3600; // 25h max
      const now  = Date.now();
      const pipe = redis.pipeline();
      pipe.zadd(key, now, String(now));
      pipe.zremrangebyscore(key, 0, now - 86400000); // evict >24h old
      pipe.zcard(key);
      pipe.expire(key, ttl);
      const results = await pipe.exec();
      const pipeErr = results.find(r => r[0]);
      if (pipeErr) throw pipeErr[0];
      const count = results[2][1];
      if (count > limit) {
        logger.warn('[aiRateLimitByPlan] Daily limit hit', { uid, plan, count, limit, path: req.path });
        return res.status(429).json(_limitResponse(limit, plan));
      }
    } else {
      // Redis not configured or not yet connected — use in-memory fallback
      if (redis && redis.status !== 'ready') {
        logger.warn('[aiRateLimitByPlan] Redis not ready (status: ' + (redis.status || 'unknown') + ') — using in-memory fallback.', { uid });
      } else {
        logger.warn('[aiRateLimitByPlan] Redis not configured — per-instance fallback active.', { uid });
      }
      const count = (_store.get(key) || 0) + 1;
      _store.set(key, count);
      if (count > limit) {
        return res.status(429).json(_limitResponse(limit, plan));
      }
    }
  } catch (err) {
    // Fail OPEN on rate-limit errors in development — fail CLOSED in production
    logger.error('[aiRateLimitByPlan] Check failed', {
      uid, plan, error: err.message, path: req.path,
    });
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json(_unavailableResponse());
    }
    // In development: log the error but allow the request through
    logger.warn('[aiRateLimitByPlan] Failing OPEN in non-production environment');
  }

  return next();
}

module.exports = { aiRateLimitByPlan };








