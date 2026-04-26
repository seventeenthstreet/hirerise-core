'use strict';

/**
 * src/core/cache/redis.cache.js  — Phase 2 Refactor
 *
 * CHANGES (Phase 2):
 *  - Accepts an injected ioredis client in the constructor (DI)
 *  - Removed all Redis client creation logic (_createSingleClient,
 *    _createClusterClient) — that is now the singleton's responsibility
 *  - isReady / getReady() delegates to the injected client's status
 *  - All existing ICache methods (get/set/delete/clearByPrefix/ping)
 *    are preserved unchanged
 *
 * NOTE: Cluster mode detection (for clearByPrefix) is preserved via
 * checking client.constructor.name === 'Cluster'.
 */

const ICache = require('./cache.interface');
const logger  = require('../../utils/logger');

class RedisCache extends ICache {
  /**
   * @param {import('ioredis').Redis | import('ioredis').Cluster} client
   *   The already-connected ioredis (or Cluster) client from the singleton.
   */
  constructor(client) {
    super();

    if (!client) {
      throw new Error('[RedisCache] A Redis client must be injected via constructor');
    }

    this.client = client;

    // Detect cluster mode without creating any new connections
    this._mode = client.constructor && client.constructor.name === 'Cluster'
      ? 'cluster'
      : 'single';

    logger.info(`[RedisCache] Initialized with injected client (mode=${this._mode})`);
  }

  // ─────────────────────────────────────────────
  // READY STATE
  // ─────────────────────────────────────────────

  /**
   * Returns true when the underlying ioredis client is connected and ready.
   * ioredis exposes this via client.status === 'ready'.
   */
  get isReady() {
    return this.client.status === 'ready';
  }

  // ─────────────────────────────────────────────
  // SAFE EXECUTION WRAPPER
  // ─────────────────────────────────────────────

  async _safeExec(fn) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('REDIS_TIMEOUT')), 2000)
        ),
      ]);
    } catch (err) {
      logger.error('[RedisCache] Operation failed', { error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // ICache IMPLEMENTATION
  // ─────────────────────────────────────────────

  async get(key) {
    if (!this.isReady) return null;

    const data = await this._safeExec(() => this.client.get(key));
    if (!data) return null;

    try {
      return JSON.parse(data);
    } catch {
      logger.warn('[RedisCache] JSON parse failed', { key });
      return null;
    }
  }

  async set(key, value, ttlSeconds = 300) {
    if (!this.isReady) return;

    const ttl =
      typeof ttlSeconds === 'number' && ttlSeconds > 0 && ttlSeconds < 86400
        ? ttlSeconds
        : 300;

    await this._safeExec(() =>
      this.client.set(key, JSON.stringify(value), 'EX', ttl)
    );
  }

  async delete(key) {
    if (!this.isReady) return;
    await this._safeExec(() => this.client.del(key));
  }

  async del(key) {
    return this.delete(key);
  }

  async clearByPrefix(prefix) {
    if (!this.isReady) return;

    try {
      let keys = [];

      if (this._mode === 'cluster') {
        const nodes = this.client.nodes('master');

        for (const node of nodes) {
          let cursor = '0';
          do {
            const [nextCursor, found] = await node.scan(
              cursor,
              'MATCH',
              `${prefix}*`,
              'COUNT',
              200
            );
            cursor = nextCursor;
            keys.push(...found);
          } while (cursor !== '0');
        }
      } else {
        keys = await this.client.keys(`${prefix}*`);
      }

      if (!keys.length) return;

      await Promise.all(keys.map(k => this.client.del(k)));

      logger.debug('[RedisCache] clearByPrefix', {
        prefix,
        deleted: keys.length,
      });

    } catch (err) {
      logger.error('[RedisCache] clearByPrefix error', {
        prefix,
        error: err.message,
      });
    }
  }

  // ─────────────────────────────────────────────
  // HEALTH CHECKS
  // ─────────────────────────────────────────────

  async ping() {
    const start = Date.now();

    try {
      const reply = await this._safeExec(() => this.client.ping());
      return {
        ok: reply === 'PONG',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  async clusterInfo() {
    if (this._mode !== 'cluster') return null;

    try {
      const masters  = this.client.nodes('master');
      const replicas = this.client.nodes('slave');

      return {
        masters:  masters.length,
        replicas: replicas.length,
      };
    } catch {
      return null;
    }
  }
}

module.exports = RedisCache;
