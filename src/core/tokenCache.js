'use strict';

/**
 * src/core/tokenCache.js
 *
 * FIX: The `set()` function received `user` (a Supabase User object) as its
 * second argument but was treating it like a Firebase decoded token with a
 * top-level `.exp` field. Supabase User objects don't have `.exp` at the
 * top level — it lives inside the JWT payload.
 *
 * WHAT WAS BROKEN:
 *   auth.middleware.js called:
 *     tokenCache.set(rawToken, user, claimSet)
 *   where `user` = { id, email, app_metadata, ... } (Supabase User)
 *
 *   computeTtl(user) then did:
 *     if (!decoded.exp) return TOKEN_CACHE_TTL + jitter;  // always hit this
 *   → every token was cached for the full 5-minute TTL regardless of actual
 *     token expiry. For short-lived tokens this meant stale sessions could
 *     be served from cache after the token expired.
 *
 * WHAT CHANGED:
 *   - set() now accepts `jwtExpSeconds` (a plain number) instead of `decoded`
 *   - auth.middleware.js must decode the JWT payload to extract `exp` before
 *     calling tokenCache.set() — see the updated call site in auth.middleware.js
 *   - computeTtl() is simplified: takes `expSeconds` directly
 *   - All other behaviour (Redis key, get(), revoke(), jitter) is unchanged
 *
 * SECURITY GUARANTEES (unchanged):
 *   1. Cache key = SHA-256 of raw token — attacker with key can't reconstruct token
 *   2. TTL bounded by token exp — expired tokens auto-evict
 *   3. Revocation window = up to TOKEN_CACHE_TTL (5 min) after revocation
 *   4. Redis unavailable → falls back to direct Supabase verification
 */

const crypto = require('crypto');
const logger  = require('../utils/logger');

const TOKEN_CACHE_TTL  = 300; // 5 minutes max (before jitter)
const TOKEN_JITTER_MAX = 30;  // jitter up to 30 seconds
const CACHE_KEY_PREFIX = 'token:verified:';

let _redisClient = null;

function getRedis() {
  if (_redisClient) return _redisClient;
  try {
    const mgr = require('./cache/cache.manager');
    const c   = mgr.getClient();
    if (c && typeof c.get === 'function') {
      _redisClient = c;
    }
  } catch { /* Redis unavailable — fallback to direct verification */ }
  return _redisClient;
}

/**
 * tokenKey(rawToken)
 * SHA-256 of the raw Bearer token string used as the Redis key.
 */
function tokenKey(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return `${CACHE_KEY_PREFIX}${hash}`;
}

/**
 * computeTtl(expSeconds)
 *
 * Returns the cache TTL in seconds:
 *   min(TOKEN_CACHE_TTL, secondsUntilExpiry) + jitter(0–TOKEN_JITTER_MAX)
 *
 * Jitter prevents cache stampedes when many tokens are created simultaneously.
 * The jitter is capped so the final TTL never exceeds the token's natural expiry.
 *
 * @param {number|undefined} expSeconds — JWT `exp` claim (Unix timestamp in seconds)
 * @returns {number} TTL in seconds (≥ 0)
 */
function computeTtl(expSeconds) {
  const jitter = Math.floor(Math.random() * TOKEN_JITTER_MAX);

  if (!expSeconds) return TOKEN_CACHE_TTL + jitter;

  const secondsUntilExpiry = expSeconds - Math.floor(Date.now() / 1000);
  if (secondsUntilExpiry <= 0) return 0; // already expired

  const baseTtl       = Math.min(TOKEN_CACHE_TTL, secondsUntilExpiry);
  const ttlWithJitter = baseTtl + jitter;

  // Never cache past the token's actual expiry
  return Math.min(ttlWithJitter, secondsUntilExpiry);
}

/**
 * get(rawToken)
 *
 * Retrieve a verified claim set from Redis cache.
 * Returns null on cache miss, Redis error, or if the cached token is expired.
 *
 * @param {string} rawToken
 * @returns {Promise<object|null>}
 */
async function get(rawToken) {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const cached = await redis.get(tokenKey(rawToken));
    if (!cached) return null;

    const claims = JSON.parse(cached);

    // Double-check expiry even if Redis TTL hasn't fired (clock skew defence)
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
      logger.debug('[TokenCache] Cached token expired (clock skew), returning null');
      return null;
    }

    return claims;
  } catch (err) {
    logger.warn('[TokenCache] GET failed', { err: err.message });
    return null;
  }
}

/**
 * set(rawToken, jwtExpSeconds, claimSet)
 *
 * Store a verified claim set in Redis.
 *
 * CHANGED SIGNATURE vs. original:
 *   OLD: set(rawToken, decoded, claimSet)     — decoded = Firebase token object
 *   NEW: set(rawToken, jwtExpSeconds, claimSet) — jwtExpSeconds = JWT exp (number)
 *
 * Callers must extract `exp` from the JWT payload before calling this:
 *   const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
 *   tokenCache.set(rawToken, payload.exp, claimSet);
 *
 * @param {string} rawToken
 * @param {number|undefined} jwtExpSeconds — JWT `exp` claim value
 * @param {object} claimSet  — normalized req.user object to cache
 */
async function set(rawToken, jwtExpSeconds, claimSet) {
  const redis = getRedis();
  if (!redis) return;

  const ttl = computeTtl(jwtExpSeconds);
  if (ttl <= 0) return; // Already expired, don't cache

  try {
    await redis.set(
      tokenKey(rawToken),
      JSON.stringify({ ...claimSet, exp: jwtExpSeconds }),
      'EX',
      ttl
    );
    logger.debug('[TokenCache] Token cached', { ttl, uid: claimSet.uid });
  } catch (err) {
    logger.warn('[TokenCache] SET failed', { err: err.message });
  }
}

/**
 * revoke(rawToken)
 *
 * Manually evict a token from cache for immediate revocation.
 * Useful after forced sign-out, account suspension, or security incidents.
 *
 * @param {string} rawToken — the raw Bearer token string
 */
async function revoke(rawToken) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(tokenKey(rawToken));
    logger.info('[TokenCache] Token manually evicted from cache');
  } catch (err) {
    logger.warn('[TokenCache] Revocation failed', { err: err.message });
  }
}

module.exports = { get, set, revoke, tokenKey };








