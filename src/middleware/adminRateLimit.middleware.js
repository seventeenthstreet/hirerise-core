'use strict';

/**
 * Wave 1 Production-Hardened adminRateLimit.middleware.js
 *
 * Hardening:
 *  - auth contract drift safe (id + uid)
 *  - RPC return-shape tolerance
 *  - schema drift observability
 *  - timeout fail-open preserved
 *  - stronger config validation
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const RATE_LIMIT_RPC = 'check_rate_limit';
const DEFAULT_TIMEOUT_MS = 1500;

const RATE_LIMIT_RESPONSE = (code, message) => ({
  success: false,
  error: {
    code,
    message,
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

        logger[logLevel]('RateLimit RPC Error', {
          key,
          rpc: RATE_LIMIT_RPC,
          limit,
          windowSeconds,
          code: error.code,
          error: error.message,
        });

        return next(); // fail-open preserved
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

      logger[logLevel]('RateLimit Middleware Failure', {
        key,
        rpc: RATE_LIMIT_RPC,
        limit,
        windowSeconds,
        error: err.message,
      });

      return next(); // fail-open preserved
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

module.exports = {
  adminRateLimit,
  masterRateLimit,
  createRateLimiter,
};
