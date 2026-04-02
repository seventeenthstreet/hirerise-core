'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

const CACHE_VERSION = 'v2';

const TOKEN_CACHE_TTL = 300;
const TOKEN_JITTER_MAX = 30;
const CACHE_KEY_PREFIX = 'token:verified:';

const MAX_PAYLOAD_SIZE = 5000;

let _redis = null;
let _lastFailure = 0;

// ─────────────────────────────────────────────
// Redis getter (ASYNC + CIRCUIT BREAKER)
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
    logger.warn('[TokenCache] Redis init failed', { error: err.message });
  }

  return null;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function tokenKey(rawToken) {
  const hash = crypto
    .createHash('sha256')
    .update(`${CACHE_VERSION}:${rawToken}`)
    .digest('hex');

  return `${CACHE_KEY_PREFIX}${hash}`;
}

function computeTtl(expSeconds) {
  const jitter = Math.floor(Math.random() * TOKEN_JITTER_MAX);

  if (!expSeconds) return TOKEN_CACHE_TTL + jitter;

  const now = Math.floor(Date.now() / 1000);
  const secondsUntilExpiry = expSeconds - now;

  if (secondsUntilExpiry <= 0) return 0;

  const baseTtl = Math.min(TOKEN_CACHE_TTL, secondsUntilExpiry);
  return Math.min(baseTtl + jitter, secondsUntilExpiry);
}

// ─────────────────────────────────────────────
// Safe Redis Exec
// ─────────────────────────────────────────────

async function safeExec(fn, label) {
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), 500)
      ),
    ]);
  } catch (err) {
    logger.warn('[TokenCache] Redis op failed', {
      label,
      error: err.message,
    });
    return null;
  }
}

// ─────────────────────────────────────────────
// Cache API
// ─────────────────────────────────────────────

async function get(rawToken) {
  const redis = await getRedis();
  if (!redis) return null;

  const key = tokenKey(rawToken);

  try {
    const cached = await safeExec(() => redis.get(key), 'GET');
    if (!cached) return null;

    let claims;
    try {
      claims = JSON.parse(cached);
    } catch {
      return null;
    }

    // Negative cache
    if (claims._invalid === true) return null;

    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return { ...claims, _cached: true };

  } catch {
    return null;
  }
}

async function set(rawToken, jwtExpSeconds, claimSet) {
  const redis = await getRedis();
  if (!redis) return;

  const ttl = computeTtl(jwtExpSeconds);
  if (ttl <= 0) return;

  try {
    const payload = {
      ...claimSet,
      exp: jwtExpSeconds,
    };

    const serialized = JSON.stringify(payload);

    if (serialized.length > MAX_PAYLOAD_SIZE) {
      logger.warn('[TokenCache] Payload too large');
      return;
    }

    await safeExec(
      () => redis.set(tokenKey(rawToken), serialized, 'EX', ttl),
      'SET'
    );

  } catch (err) {
    logger.warn('[TokenCache] SET failed', { error: err.message });
  }
}

// 🔥 NEW: negative caching (very important)
async function setInvalid(rawToken, ttl = 60) {
  const redis = await getRedis();
  if (!redis) return;

  await safeExec(
    () =>
      redis.set(
        tokenKey(rawToken),
        JSON.stringify({ _invalid: true }),
        'EX',
        ttl
      ),
    'SET_INVALID'
  );
}

async function revoke(rawToken) {
  const redis = await getRedis();
  if (!redis) return;

  await safeExec(
    () => redis.del(tokenKey(rawToken)),
    'DEL'
  );

  logger.info('[TokenCache] Token revoked');
}

module.exports = {
  get,
  set,
  setInvalid, // 🔥 new
  revoke,
  tokenKey,
};