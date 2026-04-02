'use strict';

/**
 * adminRateLimit.middleware.js
 *
 * Production-grade rate limiting using Supabase RPC.
 *
 * Features:
 *  - Distributed-safe (multi-instance ready)
 *  - Atomic DB enforcement
 *  - Fail-open strategy
 *  - Timeout protection
 *  - Clean error handling
 *
 * Requirements:
 *  - Supabase RPC: check_rate_limit
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Standard API error response
 */
const RATE_LIMIT_RESPONSE = (code, message) => ({
  success: false,
  error: {
    code,
    message,
    timestamp: new Date().toISOString(),
  },
});

/**
 * Safe RPC call with timeout
 */
async function callRateLimitRPC(params) {
  return Promise.race([
    supabase.rpc('check_rate_limit', params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('RPC_TIMEOUT')), DEFAULT_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Factory: Create rate limiter middleware
 */
function createRateLimiter({ limit, windowSeconds, prefix }) {
  if (!limit || !windowSeconds || !prefix) {
    throw new Error('Invalid rate limiter configuration');
  }

  return async (req, res, next) => {
    const identifier = req.user?.uid || req.ip;

    // Safety fallback
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
        logger.error('RateLimit RPC Error', {
          key,
          error: error.message,
        });

        return next(); // Fail-open
      }

      if (data !== true) {
        return res.status(429).json(
          RATE_LIMIT_RESPONSE(
            'RATE_LIMIT_EXCEEDED',
            'Too many requests. Please try again later.'
          )
        );
      }

      return next();
    } catch (err) {
      logger.error('RateLimit Middleware Failure', {
        key,
        error: err.message,
      });

      return next(); // Fail-open
    }
  };
}

/**
 * Admin Routes → 50 req / minute
 */
const adminRateLimit = createRateLimiter({
  limit: 50,
  windowSeconds: 60,
  prefix: 'admin',
});

/**
 * Master Routes → 30 req / minute
 */
const masterRateLimit = createRateLimiter({
  limit: 30,
  windowSeconds: 60,
  prefix: 'master',
});

module.exports = {
  adminRateLimit,
  masterRateLimit,
};