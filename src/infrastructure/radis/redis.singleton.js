/**
 * @deprecated
 * Use src/config/redisClient.js instead.
 * This file is a compatibility shim only. See module comment below.
 */

'use strict';

/**
 * src/infrastructure/radis/redis.singleton.js
 *
 * ⚠️  COMPATIBILITY WRAPPER — DO NOT USE FOR NEW CODE ⚠️
 *
 * This module is a thin shim that delegates every call to the CANONICAL
 * Redis module: src/config/redisClient.js
 *
 * HISTORY:
 *   This file was previously a standalone Redis client that was never
 *   connected during bootstrap (connectRedis() in bootstrap connects
 *   src/config/redisClient.js, not this module). That caused:
 *     - CacheManager to permanently return MemoryCache (false "not ready")
 *     - alert.service / sla.service to silently skip Redis ops
 *     - health endpoint to always report redis.ready=false
 *
 * CURRENT STATE:
 *   All active callers (sla.service, alert.service, health.routes, cache.manager)
 *   now read from src/config/redisClient.js directly.
 *   This wrapper is kept to prevent import errors from any require() path
 *   not yet updated. It provides the same public surface (isReady, getClient,
 *   circuitBreaker, connect, quit, safeExec) but sources every value from
 *   the canonical module.
 *
 * DO NOT:
 *   - Add new require() paths to this file
 *   - Call connect() / quit() from this file (lifecycle is redisClient's)
 *   - Reference this file in new code
 *
 * CANONICAL MODULE: src/config/redisClient.js
 */

const redisClient    = require('../../config/redisClient');
const circuitBreaker = require('./redis.circuitBreaker');
const logger         = require('../../utils/logger');

// One-time guard — Node's module cache means this file is evaluated only once
// per process in production, but test runners / hot-reload environments may
// re-evaluate it. The flag ensures exactly one warning line per process lifetime.
let _hasWarned = false;

if (!_hasWarned) {
  _hasWarned = true;
  logger.warn(
    '[RedisSingleton] redis.singleton.js is a compatibility shim — ' +
    'use src/config/redisClient.js directly for new code.'
  );
}

/**
 * isReady() — delegates to redisClient.getRedisClient(), which returns
 * the live ioredis instance only when _ready===true post-bootstrap.
 */
function isReady() {
  const client = redisClient.getRedisClient();
  return !!(client && client.status === 'ready');
}

/**
 * getClient() — returns the raw ioredis instance from the canonical module,
 * or null when Redis is not ready.
 */
function getClient() {
  return redisClient.getRedisClient() ?? null;
}

/**
 * connect() / quit() — no-ops; lifecycle is owned by redisClient.js.
 * Bootstrap calls connectRedis() directly; calling it again is idempotent.
 */
async function connect() {}
async function quit()    {}

/**
 * safeExec — preserves the original signature (fn, fallbackValue, timeoutMs).
 * Routes through the shared circuit breaker + redisClient.
 */
async function safeExec(fn, fallbackValue = null, timeoutMs = 5_000) {
  if (!isReady())              return fallbackValue;
  if (circuitBreaker.isOpen()) return fallbackValue;

  circuitBreaker.beginCall();
  const start = Date.now();
  let tid;

  try {
    const client = redisClient.getRedisClient();
    const result = await Promise.race([
      fn(client),
      new Promise((_, reject) => {
        tid = setTimeout(() => reject(new Error('REDIS_TIMEOUT')), timeoutMs);
      }),
    ]);
    clearTimeout(tid);
    circuitBreaker.recordSuccess(Date.now() - start);
    return result;
  } catch (err) {
    clearTimeout(tid);
    circuitBreaker.recordFailure(Date.now() - start);
    logger.warn('[RedisSingleton:shim] safeExec failed', { error: err.message });
    return fallbackValue;
  }
}

module.exports = Object.freeze({
  // lifecycle (no-ops — redisClient owns the socket)
  connect,
  quit,

  // readiness + raw client
  isReady,
  getClient,

  // circuit breaker (same shared instance used by health endpoint)
  circuitBreaker,

  // safe execution wrapper
  safeExec,

  // unified cache API — delegates to the canonical redisClient methods
  get:    (...args) => redisClient.get(...args),
  set:    (...args) => redisClient.set(...args),
  del:    (...args) => redisClient.del(...args),
  incr:   (...args) => redisClient.incr(...args),
  hget:   (...args) => redisClient.hget(...args),
  hset:   (...args) => redisClient.hset(...args),
});