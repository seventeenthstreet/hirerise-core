'use strict';

const Redis  = require('ioredis');
const ICache = require('./cache.interface');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function parseClusterNodes(envStr) {
  return envStr
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [host, portStr] = entry.split(':');
      return { host: host.trim(), port: parseInt(portStr || '6379', 10) };
    });
}

function sharedOpts() {
  return {
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  };
}

// ─────────────────────────────────────────────
// RedisCache
// ─────────────────────────────────────────────

class RedisCache extends ICache {
  constructor() {
    super();

    this.isReady = false;
    this._mode = 'single';

    const clusterNodes = process.env.REDIS_CLUSTER_NODES;

    if (clusterNodes) {
      this._mode = 'cluster';
      this.client = this._createClusterClient(clusterNodes);
    } else {
      this.client = this._createSingleClient();
    }
  }

  // ─────────────────────────────────────────────
  // CLIENT FACTORY
  // ─────────────────────────────────────────────

  _createSingleClient() {
    const client = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      ...sharedOpts(),
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });

    client.on('connect', () => {
      this.isReady = true;
      logger.info('[RedisCache] Connected (single)');
    });

    client.on('close', () => {
      this.isReady = false;
      logger.warn('[RedisCache] Disconnected (single)');
    });

    client.on('error', (err) => {
      logger.error('[RedisCache] Error (single)', { error: err.message });
    });

    return client;
  }

  _createClusterClient(clusterNodesEnv) {
    const nodes = parseClusterNodes(clusterNodesEnv);

    const client = new Redis.Cluster(nodes, {
      redisOptions: {
        ...sharedOpts(),
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
      },
      clusterRetryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 300, 3000);
      },
      enableOfflineQueue: true,
      scaleReads: 'slave',
    });

    client.on('ready', () => {
      this.isReady = true;
      logger.info('[RedisCache] Connected (cluster)');
    });

    client.on('close', () => {
      this.isReady = false;
      logger.warn('[RedisCache] Disconnected (cluster)');
    });

    client.on('error', (err) => {
      logger.error('[RedisCache] Error (cluster)', { error: err.message });
    });

    return client;
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
      const masters = this.client.nodes('master');
      const replicas = this.client.nodes('slave');

      return {
        masters: masters.length,
        replicas: replicas.length,
      };
    } catch {
      return null;
    }
  }
}

module.exports = RedisCache;