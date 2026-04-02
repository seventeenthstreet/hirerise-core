'use strict';

/**
 * CacheManager — Production Ready
 *
 * ✅ Supports Redis + Memory
 * ✅ Auto fallback to memory if Redis fails
 * ✅ Lazy initialization
 * ✅ Singleton-safe
 * ✅ Uses structured logging
 */

const MemoryCache = require('./memory.cache');
const RedisCache = require('./redis.cache');
const logger = require('../../utils/logger');

class CacheManager {
  constructor() {
    this.cache = null;
    this.initialized = false;
  }

  /**
   * Initialize cache (lazy)
   */
  async init() {
    if (this.initialized) return;

    // 🧪 Force memory in test
    if (process.env.NODE_ENV === 'test') {
      logger.info('[CacheManager] TEST mode → MemoryCache');
      this.cache = new MemoryCache();
      this.initialized = true;
      return;
    }

    const cacheType = process.env.CACHE_PROVIDER || 'memory';

    if (cacheType === 'redis') {
      try {
        logger.info('[CacheManager] Initializing Redis cache');

        const redis = new RedisCache();
        await redis.connect?.(); // optional connect()

        this.cache = redis;

        logger.info('[CacheManager] Redis cache ready');
      } catch (err) {
        logger.error('[CacheManager] Redis failed, falling back to memory', {
          error: err.message,
        });

        this.cache = new MemoryCache();
      }
    } else {
      logger.info('[CacheManager] Using Memory cache');
      this.cache = new MemoryCache();
    }

    this.initialized = true;
  }

  /**
   * Get cache client (ensures init)
   */
  async getClient() {
    if (!this.initialized) {
      await this.init();
    }
    return this.cache;
  }
}

// ✅ Singleton instance
module.exports = new CacheManager();