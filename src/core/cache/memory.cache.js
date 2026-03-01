const ICache = require('./cache.interface');

class MemoryCache extends ICache {
  constructor() {
    super();
    this.store = new Map();

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60 * 1000); // 1 min cleanup

    // ✅ CRITICAL FIX: allow process to exit naturally
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  async get(key) {
    const entry = this.store.get(key);

    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key, value, ttlSeconds = 300) {
    const expiry = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiry });
  }

  async delete(key) {
    this.store.delete(key);
  }

  async clearByPrefix(prefix) {
    for (let key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  cleanupExpired() {
    const now = Date.now();
    for (let [key, entry] of this.store.entries()) {
      if (now > entry.expiry) {
        this.store.delete(key);
      }
    }
  }
}

module.exports = MemoryCache;