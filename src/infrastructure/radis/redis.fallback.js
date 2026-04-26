'use strict';

/**
 * src/infrastructure/radis/redis.fallback.js
 *
 * NOTE: Lives in the 'radis' folder — intentional typo carried over from the
 * existing redis.singleton.js in this codebase. Do not rename without also
 * updating the require() in server.js.
 *
 * Lifecycle-managed fallback Redis client for Wave 33 cross-region failover.
 *
 * PROBLEM SOLVED:
 *   getLeaseRedisClient() in server.js previously did:
 *     const client = new Redis(fallbackUrl, {...})
 *   on every call when usingFallback=true and _fallbackClient was null.
 *   This bypassed all lifecycle management (no shutdown handler, no status
 *   tracking, potential duplicate creation under concurrent calls).
 *
 * GUARANTEES:
 *   - Single ioredis instance created exactly once (module-level singleton)
 *   - Lazy creation: only instantiated when first requested
 *   - Shutdown handler registered ONCE via process.once
 *   - isReady() uses client.status === 'ready' (authoritative ioredis state)
 *   - quit() is idempotent (safe to call multiple times)
 *   - getClient() returns null if LEASE_REDIS_FALLBACK_URL is not set
 *
 * USAGE (replaces inline new Redis() in server.js):
 *   const fallbackRedis = require('./redis.fallback');
 *   const client = fallbackRedis.getClient();   // null if not configured
 *   if (fallbackRedis.isReady()) { ... }
 *
 * BACKWARD COMPATIBILITY:
 *   leaseFailoverState._fallbackClient continues to reference the same client
 *   via getClient(). No changes required at call sites except replacing
 *   `new Redis(fallbackUrl, ...)` with `fallbackRedis.getClient()`.
 */

const Redis  = require('ioredis');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const FALLBACK_URL = process.env.LEASE_REDIS_FALLBACK_URL || null;

// ─────────────────────────────────────────────
// SINGLETON STATE
// ─────────────────────────────────────────────

/** @type {import('ioredis').Redis | null} */
let _client   = null;
let _quitting = false;

// ─────────────────────────────────────────────
// FACTORY (lazy, once)
// ─────────────────────────────────────────────

/**
 * Creates the fallback ioredis client the first time it is needed.
 * Idempotent — subsequent calls return the same instance.
 *
 * Returns null when LEASE_REDIS_FALLBACK_URL is not configured.
 *
 * @returns {import('ioredis').Redis | null}
 */
function getClient() {
  if (_client) return _client;
  if (!FALLBACK_URL) return null;

  try {
    _client = new Redis(FALLBACK_URL, {
      lazyConnect:          true,
      enableOfflineQueue:   false,
      maxRetriesPerRequest: 1,
      connectTimeout:       3_000,
      commandTimeout:       3_000,
      retryStrategy(times) {
        if (times > 5) {
          logger.error('[Redis:Fallback] Max reconnect attempts reached', { attempt: times });
          return null;
        }
        const delay = Math.min(times * 300, 2_000);
        logger.warn('[Redis:Fallback] Retrying connection', { attempt: times, delayMs: delay });
        return delay;
      },
    });

    // ── Observability ──────────────────────────────────────────
    _client.on('connect', () => {
      logger.info('[Redis:Fallback] TCP connection established');
    });

    _client.on('ready', () => {
      logger.info('[Redis:Fallback] Ready — accepting commands');
    });

    _client.on('error', (err) => {
      logger.error('[Redis:Fallback] Error', { error: err?.message || String(err) });
    });

    _client.on('reconnecting', () => {
      logger.warn('[Redis:Fallback] Reconnecting…');
    });

    _client.on('close', () => {
      logger.warn('[Redis:Fallback] Connection closed');
    });

    _client.on('end', () => {
      logger.warn('[Redis:Fallback] Connection ended (no more retries)');
    });

    logger.info('[Redis:Fallback] Client instantiated', {
      region: process.env.LEASE_REDIS_FALLBACK_REGION || 'fallback',
    });

    return _client;

  } catch (err) {
    logger.error('[Redis:Fallback] Failed to instantiate client', { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────
// READINESS
// ─────────────────────────────────────────────

/**
 * Returns true only when the client exists and ioredis reports 'ready'.
 * Uses client.status (authoritative) — not a local boolean flag.
 *
 * @returns {boolean}
 */
function isReady() {
  return !!(_client && _client.status === 'ready');
}

// ─────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────

/**
 * Gracefully closes the fallback client.
 * Idempotent — safe to call multiple times (signal + server shutdown).
 */
async function quit() {
  if (_quitting) return;    // safe no-op on double-call
  _quitting = true;

  if (_client) {
    try {
      logger.info('[Redis:Fallback] Shutting down…');
      if (_client.status !== 'end') {
        await _client.quit();
      }
    } catch (err) {
      logger.warn('[Redis:Fallback] Shutdown error', { error: err?.message });
    } finally {
      _client   = null;
      _quitting = false;   // reset so a future bootstrap can recreate if needed
    }
  } else {
    _quitting = false;
  }
}

// ─────────────────────────────────────────────
// SHUTDOWN HANDLER (registered once)
// ─────────────────────────────────────────────
// process.once guarantees this fires at most once per process lifetime
// even if the module is required multiple times (Node module cache prevents
// re-evaluation, but process.once is the belt-and-suspenders guarantee).

process.once('SIGTERM', () => quit().catch(() => {}));
process.once('SIGINT',  () => quit().catch(() => {}));

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = Object.freeze({
  getClient,
  isReady,
  quit,
});