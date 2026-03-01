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

  async clearByPrefix(prefix) {
    throw new Error("Not implemented");
  }
}

module.exports = ICache;
