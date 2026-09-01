'use strict';

/**
 * Wave 1 Production-Hardened adminRateLimit.middleware.js
 *
 * Hardening:
 *  - auth contract drift safe (id + uid)
 *  - RPC return-shape tolerance
 *  - schema drift observability
 *  - Redis incr fallback when Supabase RPC is unavailable (fail-closed)
 *  - stronger config validation
 */

const { supabase } = require('../config/supabase');
const redisClient = require('../config/redisClient');
const logger = require('../utils/logger');

const RATE_LIMIT_RPC = 'check_rate_limit';
const DEFAULT_TIMEOUT_MS = 1500;

// Phase 2B.1 — normalized to V2 canonical envelope.
// timestamp moved into meta (not error object); meta.retryAfter added for
// parser back-off extraction (parser reads meta?.retryAfter).
const RATE_LIMIT_RESPONSE = (code, message, retryAfter = 60) => ({
  success: false,
  error: {
    code,
    message,
  },
  meta: {
    retryAfter,
    timestamp: new Date().toISOString(),
  },
});

async function callRateLimitRPC(params) {
  return Promise.race([
    supabase.rpc(RATE_LIMIT_RPC, params),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('RPC_TIMEOUT')),
        DEFAULT_TIMEOUT_MS
      )
    ),
  ]);
}

function isRpcDrift(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    error?.code === '42883' ||
    msg.includes('function') ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  );
}

function isAllowed(data) {
  return (
    data === true ||
    data?.allowed === true ||
    data?.[0] === true
  );
}

/**
 * Redis fallback rate limiter.
 * Used when the Supabase RPC is unavailable. Increments a counter in Redis
 * and enforces the same limit — fail-closed, not fail-open.
 * Returns true if the request is allowed, false if the limit is exceeded.
 */
async function redisFallbackCheck(key, limit, windowSeconds) {
  try {
    const count = await redisClient.incr(`ratelimit:fallback:${key}`, windowSeconds);
    return count <= limit;
  } catch (redisErr) {
    // Redis also unavailable — log and deny to stay fail-closed
    logger.error('RateLimit Redis fallback also failed — denying request', {
      key,
      error: redisErr.message,
    });
    return false;
  }
}

function createRateLimiter({ limit, windowSeconds, prefix }) {
  if (
    !Number.isFinite(limit) ||
    limit <= 0 ||
    !Number.isFinite(windowSeconds) ||
    windowSeconds <= 0 ||
    !prefix
  ) {
    throw new Error('Invalid rate limiter configuration');
  }

  return async (req, res, next) => {
    const identifier =
      req.user?.id ||
      req.user?.uid ||
      req.ip;

    if (!identifier) {
      return next();
    }

    const key = `${prefix}:${identifier}`;

    try {
      const { data, error } = await callRateLimitRPC({
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });

      if (error) {
        const logLevel = isRpcDrift(error) ? 'warn' : 'error';

        logger[logLevel]('RateLimit RPC Error — using Redis fallback', {
          key,
          rpc: RATE_LIMIT_RPC,
          limit,
          windowSeconds,
          code: error.code,
          error: error.message,
        });

        const allowed = await redisFallbackCheck(key, limit, windowSeconds);
        if (!allowed) {
          return res.status(429).json(
            RATE_LIMIT_RESPONSE('RATE_LIMIT_EXCEEDED', 'Too many requests. Please try again later.')
          );
        }
        return next();
      }

      if (!isAllowed(data)) {
        logger.warn('Rate limit exceeded', {
          key,
          limit,
          windowSeconds,
        });

        return res.status(429).json(
          RATE_LIMIT_RESPONSE(
            'RATE_LIMIT_EXCEEDED',
            'Too many requests. Please try again later.'
          )
        );
      }

      return next();
    } catch (err) {
      const logLevel = isRpcDrift(err) ? 'warn' : 'error';

      logger[logLevel]('RateLimit Middleware Failure — using Redis fallback', {
        key,
        rpc: RATE_LIMIT_RPC,
        limit,
        windowSeconds,
        error: err.message,
      });

      const allowed = await redisFallbackCheck(key, limit, windowSeconds);
      if (!allowed) {
        return res.status(429).json(
          RATE_LIMIT_RESPONSE('RATE_LIMIT_EXCEEDED', 'Too many requests. Please try again later.')
        );
      }
      return next();
    }
  };
}

const adminRateLimit = createRateLimiter({
  limit: 50,
  windowSeconds: 60,
  prefix: 'admin',
});

const masterRateLimit = createRateLimiter({
  limit: 30,
  windowSeconds: 60,
  prefix: 'master',
});

// WP-ADMIN-INTEL-02: Secrets Manager mutation rate limit.
//
// server.js's Secrets Manager mount comment has documented "Mutation
// endpoints rate-limited to 10 requests/hour/admin UID" since the module
// was introduced, but no rate limiter was ever actually mounted on
// secrets.routes.js — the documentation was aspirational, not stale (it
// was never implemented in the first place). This closes that gap using
// the existing, already-hardened createRateLimiter() factory (fail-closed
// Redis fallback, same RPC-backed limiter every other admin/master rate
// limit in this file uses) — no new rate-limiting framework, just a new
// instance matching the limit/window server.js already documents.
//
// Applied only to the mutating secrets routes (create/update, delete) —
// GET/list/status reads are unaffected, matching the "Mutation endpoints"
// wording in the docs this corrects.
const secretsMutationRateLimit = createRateLimiter({
  limit: 10,
  windowSeconds: 60 * 60,
  prefix: 'secrets-mutation',
});

// WP-ADMIN-INTEL-04: Intelligence non-secret configuration mutation rate
// limit. Same createRateLimiter() factory and fail-closed Redis fallback as
// every limiter above — not a new rate-limiting mechanism. A separate
// instance (rather than reusing secretsMutationRateLimit) because these
// writes are not secret mutations and a naming/metrics collision with the
// Secrets Manager's own limiter would be confusing; the limit itself is set
// to the same conservative 10/hour/admin-UID precedent secretsMutationRateLimit
// established for admin-driven Intelligence writes.
const intelligenceConfigMutationRateLimit = createRateLimiter({
  limit: 10,
  windowSeconds: 60 * 60,
  prefix: 'intelligence-config-mutation',
});

// WP-ADMIN-INTEL-06: Intelligence provider registry mutation rate limit
// (add/update/remove a provider, and set/replace a custom provider's
// credential). Same createRateLimiter() factory and fail-closed Redis
// fallback as every limiter above — not a new rate-limiting mechanism. A
// separate instance from secretsMutationRateLimit / intelligenceConfig
// MutationRateLimit for the same metrics-collision reason those two are
// kept separate from each other; same conservative 10/hour/admin-UID
// precedent.
const intelligenceProviderMutationRateLimit = createRateLimiter({
  limit: 10,
  windowSeconds: 60 * 60,
  prefix: 'intelligence-provider-mutation',
});

module.exports = {
  adminRateLimit,
  masterRateLimit,
  secretsMutationRateLimit,
  intelligenceConfigMutationRateLimit,
  intelligenceProviderMutationRateLimit,
  createRateLimiter,
};