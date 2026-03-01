'use strict';

const Redis = require('ioredis');
const ICache = require('./cache.interface');

class RedisCache extends ICache {
  constructor() {
    super();

    this.client = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy(times) {
        if (times > 3) {
          return null; // stop retrying after 3 attempts
        }
        return Math.min(times * 200, 2000);
      },
    });

    // Successful connection
    this.client.on('connect', () => {
      console.log('Redis connected successfully');
    });

    // Error handling
    this.client.on('error', (err) => {
      console.error('Redis Error:', err.message);
    });
  }

  async get(key) {
    try {
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      console.error('Redis GET error:', err.message);
      return null;
    }
  }

  async set(key, value, ttlSeconds = 300) {
    try {
      await this.client.set(
        key,
        JSON.stringify(value),
        'EX',
        ttlSeconds
      );
    } catch (err) {
      console.error('Redis SET error:', err.message);
    }
  }

  async delete(key) {
    try {
      await this.client.del(key);
    } catch (err) {
      console.error('Redis DELETE error:', err.message);
    }
  }

  async clearByPrefix(prefix) {
    try {
      const keys = await this.client.keys(`${prefix}*`);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    } catch (err) {
      console.error('Redis clearByPrefix error:', err.message);
    }
  }
}

module.exports = RedisCache;
