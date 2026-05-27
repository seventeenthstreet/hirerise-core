'use strict';

/**
 * src/utils/freshnessCache.js
 *
 * Phase 2 warm-path optimization — bounded short-TTL in-memory cache for
 * freshness metadata lookups used by ETag generation on:
 *   GET /api/v1/app-entry
 *   GET /api/v1/users/me
 *
 * Design constraints:
 *   - Plain Map — zero external dependencies.
 *   - Process-local only — no Redis, no IPC, no distributed state.
 *   - Bounded size — evicts oldest entry (FIFO) when MAX_ENTRIES is exceeded.
 *   - Short TTL (default 5 s) — stale window is tight and bounded.
 *   - No timers / intervals / background sweepers.
 *   - Opportunistic cleanup on every set (one eviction at a time keeps it O(1)).
 *
 * Cache key convention:
 *   "app-entry:<userId>"   — for fetchAppEntryFreshnessMetadata()
 *   "user-me:<userId>"     — for fetchUserFreshnessMetadata()
 *
 * Safety guarantees:
 *   - Null / undefined values are NEVER cached (failed queries must not
 *     poison the cache).
 *   - get() returns null on miss or expiry; caller must treat null as a
 *     full cache miss and execute the underlying Supabase query normally.
 *   - delete() is a no-op when the key does not exist.
 *   - All methods are synchronous — no async overhead on the hot path.
 */

const FRESHNESS_CACHE_TTL_MS = Number(
  process.env.FRESHNESS_CACHE_TTL_MS ?? '5000'
);

const FRESHNESS_CACHE_MAX_ENTRIES = Number(
  process.env.FRESHNESS_CACHE_MAX_ENTRIES ?? '5000'
);

/** @type {Map<string, { data: object, expiresAt: number }>} */
const cache = new Map();

/**
 * Retrieve a cached freshness metadata entry.
 *
 * @param {string} key
 * @returns {object|null}  The cached data, or null on miss / expiry.
 */
function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Store a freshness metadata entry.
 *
 * Null and undefined values are silently ignored — failed queries must
 * never enter the cache.
 *
 * Opportunistic FIFO eviction runs before the insert when the cache is
 * at capacity: deletes the oldest key in O(1) (Map preserves insertion
 * order, so .keys().next().value is the oldest entry).
 *
 * @param {string} key
 * @param {object} data   Must be a non-null object.
 */
function set(key, data) {
  if (data === null || data === undefined) return;

  // Evict oldest entry when at capacity (before inserting new one).
  if (cache.size >= FRESHNESS_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }

  cache.set(key, {
    data,
    expiresAt: Date.now() + FRESHNESS_CACHE_TTL_MS,
  });
}

/**
 * Invalidate a specific cache entry.
 * Safe to call with a key that does not exist.
 *
 * @param {string} key
 */
function del(key) {
  cache.delete(key);
}

/**
 * Return the current number of entries (test / monitoring helper only).
 * @returns {number}
 */
function size() {
  return cache.size;
}

module.exports = { get, set, del, size, FRESHNESS_CACHE_TTL_MS, FRESHNESS_CACHE_MAX_ENTRIES };