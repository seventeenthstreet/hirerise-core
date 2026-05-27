'use strict';

/**
 * src/core/cache/cache.manager.js  — Phase 2 Refactor
 *
 * Design:
 *  - Exports a SINGLETON INSTANCE (preserves existing require() pattern)
 *  - getClient() is SYNCHRONOUS — no await at call sites
 *  - Lazily reads from redisClient (connected during bootstrap via connectRedis())
 *  - Falls back to MemoryCache when Redis is disabled / not ready
 *
 * USAGE (unchanged from Phase 1):
 *   const cacheManager = require('.../cache.manager');
 *   const cache = cacheManager.getClient();  // ← synchronous, no await
 *
 * READINESS SOURCE:
 *  - redisClient.getRedisClient() returns the live ioredis client only when
 *    _ready===true AND _redis is set. This is set by connectRedis() in bootstrap.
 *  - redis.singleton is a separate module that is never connected by bootstrap,
 *    so it must NOT be used as the readiness source here.
 *
 * BOOTSTRAP-COMPLETE MARKER:
 *  - markBootstrapComplete() is called by server.js bootstrap() immediately
 *    after connectRedis() resolves. Before that point, any getClient() fallback
 *    to MemoryCache is expected transient behaviour and is logged at DEBUG.
 *    After that point, falling back to MemoryCache is unexpected and is logged
 *    at WARN so genuine post-bootstrap Redis failures remain visible.
 */

const MemoryCache = require('./memory.cache');
const logger      = require('../../utils/logger');

class CacheManager {
  constructor() {
    this._client          = null;
    this._bootstrapComplete = false;
  }

  /**
   * Signal that connectRedis() has completed successfully.
   * Called once by bootstrap() after `await connectRedis()` resolves.
   * Switches the MemoryCache-fallback log level from DEBUG → WARN so that
   * genuine post-bootstrap Redis failures are still visible in production.
   */
  markBootstrapComplete() {
    this._bootstrapComplete = true;
  }

  /**
   * Returns the cache client synchronously.
   *
   * On first call: resolves from redisClient, which is already connected
   * because bootstrap awaits connectRedis() before app.listen().
   * Subsequent calls return the cached reference — zero overhead.
   *
   * @returns {import('ioredis').Redis | MemoryCache}
   */
  getClient() {
    if (this._client) return this._client;

    // Lazy resolution — safe post-bootstrap.
    // redisClient.getRedisClient() returns the live ioredis instance only when
    // _ready===true (set by connectRedis() completing in bootstrap). This is the
    // module bootstrap actually calls — redis.singleton is a separate module that
    // bootstrap never connects, so it must not be used here.
    try {
      const redisClient = require('../../config/redisClient');
      const client = redisClient.getRedisClient?.();

      if (client) {
        // Permanently cache the real Redis client.
        this._client = client;
        logger.info('[CacheManager] Resolved Redis client from redisClient');
        return this._client;
      }
    } catch (_) {
      // redisClient not available in test environment — fall through
    }

    // Fallback: return a MemoryCache but do NOT store it on this._client.
    // This allows the next call (after Redis becomes ready post-bootstrap)
    // to transparently upgrade to the real Redis client.
    //
    // Log level depends on lifecycle position:
    //  - Pre-bootstrap (bootstrapComplete=false): DEBUG only.
    //    Redis is intentionally not connected yet; this is expected transient
    //    state during module initialisation and early service requires().
    //  - Post-bootstrap (bootstrapComplete=true): WARN.
    //    Redis should be connected at this point; falling back to MemoryCache
    //    indicates a genuine Redis failure that operators need to see.
    if (this._bootstrapComplete) {
      logger.warn('[CacheManager] Redis not ready — returning MemoryCache (not cached)');
    } else {
      logger.debug('[CacheManager] Pre-bootstrap: Redis not yet connected, using MemoryCache');
    }
    return new MemoryCache();
  }

  /**
   * Explicit DI override — inject a specific client.
   * Call before any getClient() to pin the client (e.g. in tests).
   *
   * @param {import('ioredis').Redis | MemoryCache} client
   */
  setClient(client) {
    this._client = client;
  }

  /** Resets the resolved client — useful between tests. */
  reset() {
    this._client          = null;
    this._bootstrapComplete = false;
  }
}

// ✅ Singleton instance — same module.exports shape as Phase 1
module.exports = new CacheManager();