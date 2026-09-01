'use strict';

/**
 * @file src/modules/intelligenceConfig/intelligenceConfig.resolver.js
 *
 * WP-ADMIN-INTEL-04 — runtime precedence resolver for admin-configurable
 * Intelligence settings.
 *
 * Precedence (highest to lowest):
 *   1. Administrative override (public.intelligence_config_overrides)
 *   2. Deployment environment value (definition.envVar)
 *   3. Code default (definition.codeDefault)
 *
 * This never mutates `process.env` — the environment tier is read exactly
 * as aiProviderManager.js already reads it today (`process.env[envVar]`).
 * Admin overrides are additive on top of the pre-existing two-tier
 * precedence; if no override is ever written, resolution is byte-for-byte
 * identical to pre-WP-ADMIN-INTEL-04 behavior.
 *
 * Caching: a resolved admin-override lookup is cached in-process for
 * CACHE_TTL_MS so the hot resume-extraction path does not hit the database
 * on every call. `invalidate(key)` is called synchronously by the service
 * layer on every write/delete, so the SAME process that made the change
 * sees it on its very next resolution; other processes (if this ever runs
 * multi-instance) pick it up within the TTL window. This is a bounded-
 * staleness dynamic update, not a live push — documented here rather than
 * overclaiming instant global propagation.
 *
 * Fails safe: any repository error or invalid persisted value is logged
 * and treated as "no admin override" for that resolution — the request
 * falls through to the environment/default tiers rather than throwing.
 */

const logger = require('../../utils/logger');
const { getDefinition } = require('./intelligenceConfig.definitions');
const repository = require('./intelligenceConfig.repository');

const CACHE_TTL_MS = 30_000;

// key -> { value: string|null, expiresAt: number }
// value === null means "confirmed no admin override is set" (also cached,
// so a key that has never been configured doesn't hit the DB on every
// single resolution either).
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCached(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Invalidate (or write-through update) the cache entry for a key.
 * Called by intelligenceConfig.service.js immediately after every
 * successful upsert/delete so the writing process resolves the new value
 * on its next call rather than waiting out the TTL.
 *
 * @param {string} key
 * @param {string|null} [newValue] — pass the new value to write-through;
 *   omit to simply drop the cache entry (next read re-fetches).
 */
function invalidate(key, newValue) {
  if (newValue === undefined) {
    cache.delete(key);
    return;
  }
  setCached(key, newValue);
}

/**
 * Read the current admin override for a key, using the cache when fresh.
 * Never throws — a lookup failure resolves to `null` (no override), the
 * same outward result as "not configured".
 *
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function readAdminOverride(key) {
  const cached = getCached(key);
  if (cached !== undefined) return cached;

  try {
    const row = await repository.findByKey(key);
    const value = row ? row.value : null;
    setCached(key, value);
    return value;
  } catch (err) {
    logger.warn('[IntelligenceConfig] Admin override lookup failed — falling back', {
      key,
      error: err?.message,
    });
    // Deliberately not cached: a transient DB error should not pin every
    // resolution to "no override" for the full TTL window.
    return null;
  }
}

/**
 * Resolve the effective raw string value for a configuration key, applying
 * the full admin override -> environment -> code default precedence, and
 * validating a persisted admin override before trusting it (a value that
 * was valid when written can never become invalid later since this
 * registry has no retroactive validation-rule changes, but this guard
 * keeps resolution fail-safe against any future definition change or
 * direct DB edit).
 *
 * @param {string} key
 * @returns {Promise<{ value: string, source: 'admin'|'environment'|'default' }>}
 */
async function resolveEffective(key) {
  const definition = getDefinition(key);
  if (!definition) {
    throw Object.assign(
      new Error(`Unsupported Intelligence configuration key: '${key}'.`),
      { status: 400, code: 'UNKNOWN_CONFIG_KEY' }
    );
  }

  const override = await readAdminOverride(key);
  if (override !== null) {
    const result = definition.validate(override);
    if (result.valid) {
      return { value: result.normalized, source: 'admin' };
    }
    // Malformed persisted value: fail safe, do not throw, do not apply it.
    logger.error('[IntelligenceConfig] Persisted admin override failed validation — ignoring', {
      key,
      error: result.error,
    });
  }

  const envValue = definition.envVar ? process.env[definition.envVar] : undefined;
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    const result = definition.validate(envValue);
    if (result.valid) {
      return { value: result.normalized, source: 'environment' };
    }
    logger.warn('[IntelligenceConfig] Environment value failed validation — falling back to default', {
      key,
      envVar: definition.envVar,
      error: result.error,
    });
  }

  return { value: definition.codeDefault, source: 'default' };
}

/**
 * Convenience wrapper used by aiProviderManager.js: resolves
 * AI_PROVIDER_PRIORITY through the full precedence chain and returns it
 * already parsed into an ordered provider-name array, matching the shape
 * `getProviderPriority()` has always returned.
 *
 * @returns {Promise<string[]>}
 */
async function resolveProviderPriority() {
  const { value } = await resolveEffective('AI_PROVIDER_PRIORITY');
  return value.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
}

module.exports = {
  resolveEffective,
  resolveProviderPriority,
  invalidate,
  CACHE_TTL_MS,
};
