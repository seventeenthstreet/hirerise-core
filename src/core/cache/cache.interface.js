class ICache {
  async get(key) {
    throw new Error("Not implemented");
  }

  async set(key, value, ttlSeconds) {
    throw new Error("Not implemented");
  }

  async delete(key) {
    throw new Error("Not implemented");
  }

  /** Alias for delete() — some callers use cache.del() (node-cache / ioredis convention) */
  async del(key) {
    return this.delete(key);
  }

  async clearByPrefix(prefix) {
    throw new Error("Not implemented");
  }
}

module.exports = ICache;








