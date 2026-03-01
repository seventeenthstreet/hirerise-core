'use strict';

/**
 * lock.service.js
 */

if (process.env.NODE_ENV === 'test') {
  class MockLockService {
    async acquire() {
      return { release: async () => true };
    }

    async release() {
      return true;
    }

    async executeWithLock(_resource, fn) {
      return await fn();
    }
  }

  module.exports = new MockLockService();

} else {

  const Redis = require("ioredis");
  const Redlock = require("redlock").default;

  class LockService {
    constructor() {
      if (!process.env.REDIS_URL) {
        throw new Error("REDIS_URL is not defined in environment variables.");
      }

      this.redis = new Redis(process.env.REDIS_URL, {
        enableReadyCheck: true,
        maxRetriesPerRequest: 2,
        reconnectOnError: (err) => {
          return err.message.includes("READONLY");
        },
      });

      this.redis.on("connect", () => {
        console.log("✅ Redis connected successfully");
      });

      this.redis.on("error", (err) => {
        console.error("❌ Redis connection error:", err.message);
      });

      this.redlock = new Redlock(
        [this.redis],
        {
          driftFactor: 0.01,
          retryCount: 3,
          retryDelay: 200,
          retryJitter: 200,
        }
      );

      this.redlock.on("clientError", (err) => {
        console.error("❌ Redlock client error:", err.message);
      });
    }

    async acquire(resource, ttl = 30000) {
      try {
        return await this.redlock.acquire([resource], ttl);
      } catch (error) {
        console.error(`Lock acquisition failed for ${resource}:`, error.message);
        throw new Error("RESOURCE_LOCKED");
      }
    }

    async release(lock) {
      if (!lock) return;
      try {
        await lock.release();
      } catch (error) {
        console.error("Lock release failed:", error.message);
      }
    }

    async executeWithLock(resource, fn, ttl = 30000) {
      let lock;
      try {
        lock = await this.acquire(resource, ttl);
        return await fn();
      } finally {
        if (lock) {
          await this.release(lock);
        }
      }
    }
  }

  module.exports = new LockService();
}