'use strict';

const ICache = require('./cache.interface');

/**
 * MemoryCache — Production-ready in-memory cache
 *
 * ✅ TTL support
 * ✅ Auto cleanup
 * ✅ Max size protection
 * ✅ Stats for debugging
 * ✅ Safe for tests (destroy)
 */

class MemoryCache extends ICache {
  constructor(options = {}) {
    super();

    this.store = new Map();

    this.maxSize = options.maxSize || 1000; // 🔥 prevent memory leak
    this.defaultTTL = options.defaultTTL || 300; // seconds

    this.hits = 0;
    this.misses = 0;

    // Cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60 * 1000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  // ─────────────────────────────────────────────
  // GET
  // ─────────────────────────────────────────────
  async get(key) {
    const entry = this.store.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value;
  }

  // ─────────────────────────────────────────────
  // SET
  // ─────────────────────────────────────────────
  async set(key, value, ttlSeconds) {
    const ttl = typeof ttlSeconds === 'number' && ttlSeconds > 0
      ? ttlSeconds
      : this.defaultTTL;

    // 🔥 Prevent unbounded growth
    if (this.store.size >= this.maxSize) {
      this.evictOne();
    }

    const expiry = Date.now() + ttl * 1000;

    this.store.set(key, {
      value,
      expiry,
    });
  }

  // ─────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────
  async delete(key) {
    this.store.delete(key);
  }

  async del(key) {
    return this.delete(key);
  }

  // ─────────────────────────────────────────────
  // PREFIX CLEAR
  // ─────────────────────────────────────────────
  async clearByPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  // ─────────────────────────────────────────────
  // CLEANUP
  // ─────────────────────────────────────────────
  cleanupExpired() {
    if (this.store.size === 0) return;

    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiry) {
        this.store.delete(key);
      }
    }
  }

  // ─────────────────────────────────────────────
  // EVICTION (simple FIFO)
  // ─────────────────────────────────────────────
  evictOne() {
    const firstKey = this.store.keys().next().value;
    if (firstKey) {
      this.store.delete(firstKey);
    }
  }

  // ─────────────────────────────────────────────
  // STATS (debugging)
  // ─────────────────────────────────────────────
  getStats() {
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate:
        this.hits + this.misses === 0
          ? 0
          : (this.hits / (this.hits + this.misses)).toFixed(2),
    };
  }

  // ─────────────────────────────────────────────
  // DESTROY (important for tests)
  // ─────────────────────────────────────────────
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
  }
}

module.exports = MemoryCache;