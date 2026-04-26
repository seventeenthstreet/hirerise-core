'use strict';

/**
 * src/core/cache/cache.manager.js  — Phase 2 Refactor
 *
 * Design:
 *  - Exports a SINGLETON INSTANCE (preserves existing require() pattern)
 *  - getClient() is SYNCHRONOUS — no await at call sites
 *  - Lazily reads from redis.singleton (already connected post-bootstrap)
 *  - Falls back to MemoryCache when Redis is disabled / not ready
 *
 * USAGE (unchanged from Phase 1):
 *   const cacheManager = require('.../cache.manager');
 *   const cache = cacheManager.getClient();  // ← synchronous, no await
 *
 * CHANGES FROM PHASE 1:
 *  - getClient() is now SYNCHRONOUS (removed async/Promise)
 *  - No internal Redis creation — delegates to redis.singleton
 *  - No init() / lazy-connect logic — resolved on first getClient() call
 *  - setClient() available for DI in tests
 */

const MemoryCache = require('./memory.cache');
const logger      = require('../../utils/logger');

class CacheManager {
  constructor() {
    this._client = null;
  }

  /**
   * Returns the cache client synchronously.
   *
   * On first call: resolves from redis.singleton, which is already
   * connected because bootstrap awaits connect() before app.listen().
   * Subsequent calls return the cached reference — zero overhead.
   *
   * @returns {import('ioredis').Redis | MemoryCache}
   */
  getClient() {
    if (this._client) return this._client;

    // Lazy resolution — safe post-bootstrap
    try {
      const redisSingleton = require('../../infrastructure/radis/redis.singleton');

      if (redisSingleton && redisSingleton.isReady()) {
        // Permanently cache the real Redis client.
        this._client = redisSingleton.getClient();
        logger.info('[CacheManager] Resolved Redis client from singleton');
        return this._client;
      }
    } catch (_) {
      // singleton not available in test environment — fall through
    }

    // Fallback: return a MemoryCache but do NOT store it on this._client.
    // This allows the next call (after Redis becomes ready post-bootstrap)
    // to transparently upgrade to the real Redis client.
    logger.warn('[CacheManager] Redis not ready — returning MemoryCache (not cached)');
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
    this._client = null;
  }
}

// ✅ Singleton instance — same module.exports shape as Phase 1
module.exports = new CacheManager();
