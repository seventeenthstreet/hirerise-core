'use strict';

/**
 * ICache — Production Cache Interface
 *
 * Designed for:
 * ✅ Redis (recommended for production)
 * ✅ In-memory cache (fallback)
 * ✅ Future Supabase edge / KV caching
 *
 * Rules:
 * - All values MUST be JSON-serializable
 * - TTL is always in seconds
 */

class ICache {
  /**
   * Get value by key
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async get(key) {
    throw new Error('ICache.get() not implemented');
  }

  /**
   * Set value with optional TTL
   * @param {string} key
   * @param {any} value (JSON serializable)
   * @param {number} [ttlSeconds]
   */
  async set(key, value, ttlSeconds) {
    throw new Error('ICache.set() not implemented');
  }

  /**
   * Delete a key
   * @param {string} key
   */
  async delete(key) {
    throw new Error('ICache.delete() not implemented');
  }

  /**
   * Alias for delete (Redis-style)
   */
  async del(key) {
    return this.delete(key);
  }

  /**
   * Delete multiple keys
   * @param {string[]} keys
   */
  async deleteMany(keys) {
    if (!Array.isArray(keys)) {
      throw new Error('deleteMany expects array of keys');
    }

    await Promise.all(keys.map((k) => this.delete(k)));
  }

  /**
   * Get multiple keys (batch)
   * @param {string[]} keys
   * @returns {Promise<Record<string, any>>}
   */
  async getMany(keys) {
    if (!Array.isArray(keys)) {
      throw new Error('getMany expects array of keys');
    }

    const results = await Promise.all(
      keys.map(async (key) => ({
        key,
        value: await this.get(key),
      }))
    );

    return results.reduce((acc, { key, value }) => {
      acc[key] = value;
      return acc;
    }, {});
  }

  /**
   * Set multiple values
   * @param {Array<{key: string, value: any, ttlSeconds?: number}>} entries
   */
  async setMany(entries) {
    if (!Array.isArray(entries)) {
      throw new Error('setMany expects array');
    }

    await Promise.all(
      entries.map(({ key, value, ttlSeconds }) =>
        this.set(key, value, ttlSeconds)
      )
    );
  }

  /**
   * Clear keys by prefix (important for invalidation)
   * @param {string} prefix
   */
  async clearByPrefix(prefix) {
    throw new Error('ICache.clearByPrefix() not implemented');
  }

  /**
   * Optional: increment numeric value
   */
  async increment(key, value = 1) {
    throw new Error('ICache.increment() not implemented');
  }

  /**
   * Optional: check existence
   */
  async exists(key) {
    const val = await this.get(key);
    return val !== null && val !== undefined;
  }

  /**
   * Optional: TTL remaining
   */
  async ttl(key) {
    throw new Error('ICache.ttl() not implemented');
  }
}

module.exports = ICache;