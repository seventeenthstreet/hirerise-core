'use strict';

const MemoryCache = require('./memory.cache');
const RedisCache = require('./redis.cache');

class CacheManager {
  constructor() {
    // ✅ FORCE memory cache in test mode
    if (process.env.NODE_ENV === 'test') {
      console.log('🧪 TEST MODE: Using Memory Cache');
      this.cache = new MemoryCache();
      return;
    }

    const cacheType = process.env.CACHE_PROVIDER || 'memory';

    if (cacheType === 'redis') {
      console.log('Using Redis Cache');
      this.cache = new RedisCache();
    } else {
      console.log('Using Memory Cache');
      this.cache = new MemoryCache();
    }
  }

  getClient() {
    return this.cache;
  }
}

module.exports = new CacheManager();