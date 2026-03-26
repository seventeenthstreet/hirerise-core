'use strict';

/**
 * redis.cache.js — PHASE 4 UPDATE
 *
 * CHANGES FROM PHASE 3:
 *
 *   1. Cluster-aware client — when REDIS_CLUSTER_NODES is set, uses ioredis
 *      Cluster instead of a single Redis instance. Falls back to single-node
 *      automatically when the env var is absent (dev, staging, single-node prod).
 *
 *   2. clearByPrefix() made cluster-safe — KEYS command is not supported in
 *      cluster mode (it only runs on one shard). Replaced with a pipeline
 *      approach using SCAN on every master node.
 *
 *   3. Connection resilience tuned:
 *      - maxRetriesPerRequest: 3 (unchanged for single), cluster nodes get
 *        their own retry config so a single dead node doesn't stall the client
 *      - clusterRetryStrategy: exponential back-off capped at 3s, gives up
 *        after 5 attempts to avoid blocking callers indefinitely
 *
 * CONFIGURATION:
 *
 *   Single-node (existing, default):
 *     CACHE_PROVIDER=redis
 *     REDIS_HOST=127.0.0.1
 *     REDIS_PORT=6379
 *     REDIS_PASSWORD=...
 *     REDIS_TLS=true
 *
 *   Cluster (Phase 4):
 *     CACHE_PROVIDER=redis
 *     REDIS_CLUSTER_NODES=host1:6379,host2:6379,host3:6379
 *     REDIS_PASSWORD=...   (shared cluster password)
 *     REDIS_TLS=true
 *
 *   Google Cloud Memorystore Cluster example:
 *     REDIS_CLUSTER_NODES=10.0.0.1:6379,10.0.0.2:6379,10.0.0.3:6379
 *     REDIS_TLS=true
 *
 * @module core/cache/redis.cache
 */

const Redis   = require('ioredis');
const ICache  = require('./cache.interface');
const logger  = require('../../utils/logger');

// ─── Cluster node parser ──────────────────────────────────────────────────────

/**
 * parseClusterNodes(envStr)
 *
 * Converts "host1:6379,host2:6380" → [{ host, port }, ...]
 */
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

// ─── Shared connection options ────────────────────────────────────────────────

function sharedOpts() {
  return {
    password:  process.env.REDIS_PASSWORD || undefined,
    tls:       process.env.REDIS_TLS === 'true' ? {} : undefined,
  };
}

// ─── Cluster scan helper ──────────────────────────────────────────────────────

/**
 * scanAllMasters(cluster, pattern)
 *
 * In cluster mode, KEYS/SCAN only runs on the node it hits, missing other shards.
 * This helper iterates every master node and runs SCAN on each.
 *
 * @param {Redis.Cluster} cluster
 * @param {string} pattern
 * @returns {Promise<string[]>} all matching keys across all masters
 */
async function scanAllMasters(cluster, pattern) {
  const nodes  = cluster.nodes('master');
  const allKeys = [];

  await Promise.all(nodes.map(async (node) => {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;
      allKeys.push(...keys);
    } while (cursor !== '0');
  }));

  return allKeys;
}

// ─── RedisCache class ─────────────────────────────────────────────────────────

class RedisCache extends ICache {
  constructor() {
    super();

    const clusterNodes = process.env.REDIS_CLUSTER_NODES;

    if (clusterNodes) {
      this._mode = 'cluster';
      this.client = this._createClusterClient(clusterNodes);
      logger.info('[RedisCache] Cluster mode active', {
        nodes: parseClusterNodes(clusterNodes).map(n => `${n.host}:${n.port}`),
      });
    } else {
      this._mode = 'single';
      this.client = this._createSingleClient();
      logger.info('[RedisCache] Single-node mode active', {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
      });
    }
  }

  // ─── Client factories ──────────────────────────────────────────────────────

  _createSingleClient() {
    const client = new Redis({
      host:    process.env.REDIS_HOST || '127.0.0.1',
      port:    parseInt(process.env.REDIS_PORT || '6379', 10),
      ...sharedOpts(),
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
      retryStrategy(times) {
        if (times > 3) return null; // give up after 3 attempts
        return Math.min(times * 200, 2000);
      },
    });

    client.on('connect', () => logger.info('[RedisCache] Single node connected'));
    client.on('error',  (err) => logger.error('[RedisCache] Single node error', { error: err.message }));
    return client;
  }

  _createClusterClient(clusterNodesEnv) {
    const startupNodes = parseClusterNodes(clusterNodesEnv);

    const client = new Redis.Cluster(startupNodes, {
      redisOptions: {
        ...sharedOpts(),
        maxRetriesPerRequest: 3,
        enableReadyCheck:     true,
      },
      clusterRetryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 300, 3000);
      },
      // Slot refresh: auto-discover topology on MOVED/ASK redirects
      enableOfflineQueue: true,
      scaleReads: 'slave',  // route read-only commands to replicas where available
    });

    client.on('connect', () => logger.info('[RedisCache] Cluster connected'));
    client.on('ready',   () => logger.info('[RedisCache] Cluster ready'));
    client.on('error',   (err) => logger.error('[RedisCache] Cluster error', { error: err.message }));
    client.on('node error', (err, node) => {
      logger.warn('[RedisCache] Cluster node error', {
        node: `${node?.options?.host}:${node?.options?.port}`,
        error: err.message,
      });
    });

    return client;
  }

  // ─── ICache interface ──────────────────────────────────────────────────────

  async get(key) {
    try {
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.error('[RedisCache] GET error', { key, error: err.message });
      return null;
    }
  }

  async set(key, value, ttlSeconds = 300) {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.error('[RedisCache] SET error', { key, error: err.message });
    }
  }

  async delete(key) {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.error('[RedisCache] DELETE error', { key, error: err.message });
    }
  }

  /** Alias for delete() — matches node-cache / ioredis .del() convention */
  async del(key) {
    return this.delete(key);
  }

  /**
   * clearByPrefix — cluster-safe.
   *
   * Single-node: uses KEYS (fast, consistent)
   * Cluster:     scans all master shards via SCAN (O(n) but correct)
   */
  async clearByPrefix(prefix) {
    try {
      let keys;
      if (this._mode === 'cluster') {
        keys = await scanAllMasters(this.client, `${prefix}*`);
      } else {
        keys = await this.client.keys(`${prefix}*`);
      }

      if (keys.length === 0) return;

      // In cluster mode, keys may span shards — DEL each individually
      // (multi-key DEL only works when all keys hash to the same slot).
      if (this._mode === 'cluster') {
        await Promise.all(keys.map(k => this.client.del(k)));
      } else {
        await this.client.del(keys);
      }

      logger.debug('[RedisCache] clearByPrefix', { prefix, deletedCount: keys.length });
    } catch (err) {
      logger.error('[RedisCache] clearByPrefix error', { prefix, error: err.message });
    }
  }

  // ─── Health probe (used by synthetic monitoring) ──────────────────────────

  /**
   * ping()
   *
   * Sends a PING and expects PONG. Returns { ok, latencyMs }.
   * Used by the deep health endpoint.
   */
  async ping() {
    const start = Date.now();
    try {
      const reply = await this.client.ping();
      return { ok: reply === 'PONG', latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  /**
   * clusterInfo()
   *
   * Returns cluster node count for health endpoint.
   * Returns null in single-node mode.
   */
  async clusterInfo() {
    if (this._mode !== 'cluster') return null;
    try {
      const masters  = this.client.nodes('master');
      const replicas = this.client.nodes('slave');
      return { masters: masters.length, replicas: replicas.length };
    } catch {
      return null;
    }
  }
}

module.exports = RedisCache;








