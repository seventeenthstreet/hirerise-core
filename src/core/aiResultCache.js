'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const logger = require('../utils/logger');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const CACHE_VERSION = 'v3';
const MEMORY_CACHE_MAX = 1000;

const TTL_S = {
  fullAnalysis: parseInt(
    process.env.AI_CACHE_TTL_FULL_ANALYSIS_S ||
      String(4 * 3600),
    10
  ),
  generateCV: parseInt(
    process.env.AI_CACHE_TTL_GENERATE_CV_S ||
      String(2 * 3600),
    10
  ),
  jobMatchAnalysis: parseInt(
    process.env.AI_CACHE_TTL_JOB_MATCH_S ||
      String(2 * 3600),
    10
  ),
  jobSpecificCV: parseInt(
    process.env.AI_CACHE_TTL_JOB_SPECIFIC_CV_S ||
      String(2 * 3600),
    10
  ),
  chi_calculation: parseInt(
    process.env.AI_CACHE_TTL_CHI_S ||
      String(6 * 3600),
    10
  ),
  pipeline_v3: parseInt(
    process.env.AI_CACHE_TTL_PIPELINE_S ||
      String(2 * 3600),
    10
  ),
  default: parseInt(
    process.env.AI_CACHE_TTL_DEFAULT_S ||
      String(2 * 3600),
    10
  ),
};

const TTL_JITTER_MAX = 60;
const CACHE_ENABLED =
  process.env.AI_RESULT_CACHE_ENABLED !== 'false';
const MAX_CACHE_SIZE = 500_000;

let _redis = null;
let _lastFailure = 0;
const memoryCache = new Map();

// ─────────────────────────────────────────────
// Redis getter
// ─────────────────────────────────────────────

async function getRedis() {
  if (_redis) return _redis;
  if (Date.now() - _lastFailure < 5000) return null;

  try {
    const mgr = require('./cache/cache.manager');
    const cache = await mgr.getClient();

    if (cache?.client?.get) {
      _redis = cache.client;
      return _redis;
    }
  } catch (err) {
    _lastFailure = Date.now();
    logger.warn('[AIResultCache] Redis init failed', {
      error: err.message,
    });
  }

  return null;
}

// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────

function ttlWithJitter(feature) {
  const base = TTL_S[feature] ?? TTL_S.default;
  return base + Math.floor(Math.random() * TTL_JITTER_MAX);
}

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalize).join(',')}]`;
  }

  const keys = Object.keys(obj).sort();

  return `{${keys
    .map((k) => `"${k}":${canonicalize(obj[k])}`)
    .join(',')}}`;
}

function buildCacheKey(feature, inputPayload) {
  const canonical = canonicalize(inputPayload);
  const hash = crypto
    .createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 32);

  return `ai:result:${CACHE_VERSION}:${feature}:${hash}`;
}

function setMemoryCache(key, value, ttl) {
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }

  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttl * 1000,
  });
}

function getMemoryCache(key) {
  const hit = memoryCache.get(key);

  if (!hit) return null;

  if (Date.now() > hit.expiresAt) {
    memoryCache.delete(key);
    return null;
  }

  return { ...hit.value, _cached: true, _cacheLayer: 'memory' };
}

// ─────────────────────────────────────────────
// Compression
// ─────────────────────────────────────────────

async function compress(data) {
  const json = JSON.stringify(data);

  if (json.length > MAX_CACHE_SIZE) {
    logger.warn(
      '[AIResultCache] Skipping cache (too large)'
    );
    return null;
  }

  const gz = await gzip(json);
  return gz.toString('base64');
}

async function decompress(data) {
  try {
    const buffer = Buffer.from(data, 'base64');
    const out = await gunzip(buffer);
    return JSON.parse(out.toString());
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Safe Redis Exec
// ─────────────────────────────────────────────

async function safeExec(fn) {
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('REDIS_TIMEOUT')),
          1000
        )
      ),
    ]);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Cache Read (L1 + L2)
// ─────────────────────────────────────────────

async function checkCache(cacheKey) {
  if (!CACHE_ENABLED) return null;

  const memoryHit = getMemoryCache(cacheKey);
  if (memoryHit) return memoryHit;

  const redis = await getRedis();
  if (!redis) return null;

  try {
    const raw = await safeExec(() => redis.get(cacheKey));
    if (!raw) return null;

    const parsed = await decompress(raw);
    if (!parsed) return null;

    setMemoryCache(cacheKey, parsed, TTL_S.default);

    return {
      ...parsed,
      _cached: true,
      _cacheLayer: 'redis',
    };
  } catch (err) {
    logger.warn('[AIResultCache] Read error', {
      error: err.message,
    });
    return null;
  }
}

// ─────────────────────────────────────────────
// Cache Write
// ─────────────────────────────────────────────

async function storeCache(cacheKey, result, feature) {
  if (!CACHE_ENABLED) return;

  const ttl = ttlWithJitter(feature);

  const {
    creditsRemaining,
    _creditReservation,
    _inputTokens,
    _outputTokens,
    _observability,
    ...cacheable
  } = result;

  setMemoryCache(cacheKey, cacheable, ttl);

  const redis = await getRedis();
  if (!redis) return;

  try {
    const compressed = await compress({
      ...cacheable,
      _cachedAt: new Date().toISOString(),
    });

    if (!compressed) return;

    await safeExec(() =>
      redis.set(cacheKey, compressed, 'EX', ttl)
    );
  } catch (err) {
    logger.warn('[AIResultCache] Write error', {
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────
// Namespace-safe invalidation
// ─────────────────────────────────────────────

async function invalidateCache(feature, inputPayload) {
  const key = buildCacheKey(feature, inputPayload);
  memoryCache.delete(key);

  const redis = await getRedis();
  if (!redis) return;

  await safeExec(() => redis.del(key));
}

async function invalidateByPrefix(prefix) {
  for (const key of memoryCache.keys()) {
    if (key.includes(prefix)) {
      memoryCache.delete(key);
    }
  }

  const redis = await getRedis();
  if (!redis) return;

  let cursor = '0';

  do {
    const res = await safeExec(() =>
      redis.scan(
        cursor,
        'MATCH',
        `ai:result:${CACHE_VERSION}:${prefix}:*`,
        'COUNT',
        100
      )
    );

    if (!res) break;

    const [next, keys] = res;
    cursor = next;

    if (keys.length) {
      await safeExec(() => redis.del(...keys));
    }
  } while (cursor !== '0');
}

// ─────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────

async function getCacheStats() {
  const redis = await getRedis();

  return {
    redisAvailable: Boolean(redis),
    memoryKeys: memoryCache.size,
  };
}

module.exports = {
  buildCacheKey,
  checkCache,
  storeCache,
  invalidateCache,
  invalidateByPrefix,
  getCacheStats,
  CACHE_ENABLED,
  TTL_S,
};