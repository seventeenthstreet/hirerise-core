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

const CACHE_VERSION = 'v2'; // 🔥 bump for safety

const TTL_S = {
  fullAnalysis:     parseInt(process.env.AI_CACHE_TTL_FULL_ANALYSIS_S || String(4 * 3600), 10),
  generateCV:       parseInt(process.env.AI_CACHE_TTL_GENERATE_CV_S   || String(2 * 3600), 10),
  jobMatchAnalysis: parseInt(process.env.AI_CACHE_TTL_JOB_MATCH_S     || String(2 * 3600), 10),
  jobSpecificCV:    parseInt(process.env.AI_CACHE_TTL_JOB_SPECIFIC_CV_S || String(2 * 3600), 10),
  chi_calculation:  parseInt(process.env.AI_CACHE_TTL_CHI_S           || String(6 * 3600), 10),
  default:          parseInt(process.env.AI_CACHE_TTL_DEFAULT_S        || String(2 * 3600), 10),
};

const TTL_JITTER_MAX = 60;
const CACHE_ENABLED = process.env.AI_RESULT_CACHE_ENABLED !== 'false';
const MAX_CACHE_SIZE = 500_000; // ~500KB safety

let _redis = null;
let _lastFailure = 0;

// ─────────────────────────────────────────────
// Redis getter (SAFE)
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
    logger.warn('[AIResultCache] Redis init failed', { error: err.message });
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
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;

  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `"${k}":${canonicalize(obj[k])}`).join(',')}}`;
}

function buildCacheKey(feature, inputPayload) {
  const canonical = canonicalize(inputPayload);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `ai:result:${CACHE_VERSION}:${feature}:${hash}`;
}

// ─────────────────────────────────────────────
// Compression (ASYNC)
// ─────────────────────────────────────────────

async function compress(data) {
  const json = JSON.stringify(data);

  if (json.length > MAX_CACHE_SIZE) {
    logger.warn('[AIResultCache] Skipping cache (too large)');
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
        setTimeout(() => reject(new Error('REDIS_TIMEOUT')), 1000)
      )
    ]);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Cache Read
// ─────────────────────────────────────────────

async function checkCache(cacheKey) {
  if (!CACHE_ENABLED) return null;

  const redis = await getRedis();
  if (!redis) return null;

  try {
    const raw = await safeExec(() => redis.get(cacheKey));
    if (!raw) return null;

    const parsed = await decompress(raw);
    if (!parsed) return null;

    return { ...parsed, _cached: true };

  } catch (err) {
    logger.warn('[AIResultCache] Read error', { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────
// Cache Write
// ─────────────────────────────────────────────

async function storeCache(cacheKey, result, feature) {
  if (!CACHE_ENABLED) return;

  const redis = await getRedis();
  if (!redis) return;

  try {
    const {
      creditsRemaining,
      _creditReservation,
      _inputTokens,
      _outputTokens,
      _observability,
      ...cacheable
    } = result;

    const compressed = await compress({
      ...cacheable,
      _cachedAt: new Date().toISOString()
    });

    if (!compressed) return;

    const ttl = ttlWithJitter(feature);

    await safeExec(() =>
      redis.set(cacheKey, compressed, 'EX', ttl)
    );

  } catch (err) {
    logger.warn('[AIResultCache] Write error', { error: err.message });
  }
}

// ─────────────────────────────────────────────
// Invalidate
// ─────────────────────────────────────────────

async function invalidateCache(feature, inputPayload) {
  const redis = await getRedis();
  if (!redis) return;

  const key = buildCacheKey(feature, inputPayload);
  await safeExec(() => redis.del(key));
}

// ─────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────

async function getCacheStats() {
  const redis = await getRedis();
  if (!redis) return { keyCount: 0 };

  let cursor = '0';
  let count = 0;

  do {
    const res = await safeExec(() =>
      redis.scan(cursor, 'MATCH', 'ai:result:*', 'COUNT', 100)
    );

    if (!res) break;

    const [next, keys] = res;
    cursor = next;
    count += keys.length;

  } while (cursor !== '0');

  return { keyCount: count };
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  buildCacheKey,
  checkCache,
  storeCache,
  invalidateCache,
  getCacheStats,
  CACHE_ENABLED,
  TTL_S,
};