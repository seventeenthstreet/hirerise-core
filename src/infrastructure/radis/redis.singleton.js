'use strict';

/**
 * src/infrastructure/radis/redis.singleton.js
 *
 * THE single Redis client for this process.
 *
 * Rules enforced here:
 *  - Only ONE ioredis instance is ever created (module-level const).
 *  - `connect()` must be awaited during server bootstrap, before app.listen().
 *  - All other modules import THIS file — they never call `new Redis()`.
 *  - Shutdown is registered once via process.once so duplicate handlers
 *    are impossible even if this module is required many times (Node caches it).
 *
 * Disabled mode (CACHE_PROVIDER !== 'redis'):
 *  - Every read returns null; every write is a no-op.
 *  - isReady() returns false.
 *  - connect() / quit() are safe no-ops.
 *  This lets dev/test environments run without Redis with zero code changes
 *  in callers.
 *
 * ── Phase 3 Hardening ────────────────────────────────────────────────────────
 *
 * TASK 3 — safeExec(fn, fallbackValue = null, timeoutMs = 5_000)
 *   Generic safe-execution wrapper that:
 *   - Returns fallbackValue immediately when Redis is not ready
 *   - Races the fn() call against a configurable timeout
 *   - Catches ALL errors and returns fallbackValue (never throws)
 *   - Logs failures at warn level with the error message
 *
 * TASK 4 — Observability
 *   connect / ready / error / reconnecting / close events are all logged.
 *
 * TASK 5 — isReady() reliability
 *   isReady() cross-checks BOTH the internal _ready flag AND
 *   client.status === 'ready'.
 *
 * ── Phase 4 Resilience ───────────────────────────────────────────────────────
 *
 * CIRCUIT BREAKER (redis.circuitBreaker.js)
 *   safeExec now routes through the circuit breaker:
 *   - OPEN  → immediate fallback, no I/O attempted
 *   - HALF_OPEN → single probe allowed through; success closes, failure re-opens
 *   - CLOSED → normal execution, latency recorded
 *
 * LATENCY METRICS
 *   Every safeExec call records wall-clock latency.
 *   Stats visible via circuitBreaker.getMetrics() → health endpoint.
 *
 * DEGRADATION LOGGING
 *   Circuit state transitions logged exactly once per transition.
 *   "Not ready" path does NOT log per-call (avoids hot-path spam).
 */

const Redis         = require('ioredis');
const logger        = require('../../utils/logger');
const circuitBreaker = require('./redis.circuitBreaker');

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

// Read from env.js rather than process.env directly.
// env.js is loaded after dotenv.config() at the top of server.js, so its
// values are guaranteed to reflect the .env file. Reading process.env
// directly here was unsafe: this module can be evaluated before dotenv
// has run, making CACHE_PROVIDER undefined → fallback 'memory' → ENABLED=false.
const env     = require('../../config/env');
const ENABLED = (env.CACHE_PROVIDER || 'memory').toLowerCase() === 'redis';

// ─────────────────────────────────────────────────────────────
// DISABLED STUB  (dev / test without Redis)
// ─────────────────────────────────────────────────────────────

function buildDisabledSingleton() {
  logger.warn('[Redis] DISABLED — CACHE_PROVIDER is not "redis". Set CACHE_PROVIDER=redis and REDIS_URL to enable.', {
    CACHE_PROVIDER: process.env.CACHE_PROVIDER || '(not set — defaults to memory)',
  });
  logger.warn('[RedisSingleton] Disabled — CACHE_PROVIDER is not "redis". All cache ops are no-ops.');

  const stub = Object.freeze({
    // lifecycle
    connect:  async () => {},
    quit:     async () => {},
    isReady:  () => false,

    // raw client access (returns null — callers must guard)
    getClient: () => null,

    // unified cache API (mirrors redisClient.js contract)
    get:      async ()              => null,
    set:      async ()              => null,
    del:      async ()              => 0,
    incr:     async ()              => 0,
    expire:   async ()              => 0,
    hget:     async ()              => null,
    hset:     async ()              => null,
    keys:     async ()              => [],

    // stub always returns fallbackValue — circuit not needed when disabled
    safeExec: async (_fn, fallbackValue = null) => fallbackValue,

    // expose circuit breaker read-only so health endpoint always works
    circuitBreaker,
  });

  return stub;
}

// ─────────────────────────────────────────────────────────────
// LIVE SINGLETON
// ─────────────────────────────────────────────────────────────

function buildLiveSingleton() {
  if (!env.REDIS_URL) {
    throw new Error('[RedisSingleton] REDIS_URL is not set but CACHE_PROVIDER=redis');
  }

  // ── ioredis client ──────────────────────────────────────────
  // lazyConnect: true  → we control exactly when the TCP handshake happens
  //              (during bootstrap, before app.listen).
  const client = new Redis(env.REDIS_URL, {
    lazyConnect:          true,
    enableOfflineQueue:   false,    // fail fast; don't buffer commands while disconnected
    maxRetriesPerRequest: 1,        // surface errors quickly to callers
    connectTimeout:       5_000,
    commandTimeout:       3_000,
    retryStrategy(times) {
      if (times > 10) {
        logger.error('[RedisSingleton] Max reconnect attempts reached — giving up', { attempt: times });
        return null; // stop retrying
      }
      const delay = Math.min(times * 300, 3_000);
      logger.warn('[RedisSingleton] Retrying connection', { attempt: times, delayMs: delay });
      return delay;
    },
    reconnectOnError(err) {
      // Reconnect on READONLY errors (replica failover in managed Redis)
      if (err?.message?.includes('READONLY')) {
        logger.warn('[RedisSingleton] READONLY error — triggering reconnect');
        return true;
      }
      return false;
    },
  });

  // ── State ───────────────────────────────────────────────────
  let _ready = false;

  // ── Observability — all connection lifecycle events logged ──────────────────

  client.on('connect', () => {
    logger.info('[Redis] Connected');
    logger.info('[RedisSingleton] TCP connection established');
  });

  // TASK 3 — ready event: fired by ioredis after AUTH + SELECT succeed
  client.on('ready', () => {
    _ready = true;
    logger.info('[Redis] Ready');
    logger.info('[RedisSingleton] Ready — accepting commands');
  });

  // TASK 4 — error event: every socket / protocol error surfaces here
  client.on('error', (err) => {
    _ready = false;
    logger.error(`[Redis] Error: ${err?.message || String(err)}`, {
      code:    err?.code    || null,
      syscall: err?.syscall || null,
    });
    logger.error('[RedisSingleton] Error', { error: err?.message || String(err) });
  });

  client.on('reconnecting', () => {
    _ready = false;
    logger.warn('[Redis] Reconnecting');
    logger.warn('[RedisSingleton] Reconnecting…');
  });

  client.on('close', () => {
    _ready = false;
    logger.warn('[Redis] Connection closed');
    logger.warn('[RedisSingleton] Connection closed');
  });

  client.on('end', () => {
    _ready = false;
    logger.warn('[RedisSingleton] Connection ended (no more retries)');
  });

  // ── Lifecycle ───────────────────────────────────────────────

  /**
   * Called ONCE in server bootstrap before app.listen().
   * Idempotent — safe to call multiple times (ioredis guards internally).
   */
  async function connect() {
    if (_ready) {
      logger.info('[Redis] connect() called but already ready — skipping');
      return;
    }

    // TASK 1 — log before attempting the TCP handshake
    logger.info('[Redis] Attempting connection...', {
      url: env.REDIS_URL
        ? env.REDIS_URL.replace(/:\/\/.*@/, '://**:**@') // redact credentials
        : '(REDIS_URL not set)',
    });

    // TASK 5 — explicit try/catch so failures are always visible
    try {
      await client.connect();
      await client.ping(); // confirm round-trip

      // TASK 2 — log on success (before the PONG confirmation line)
      logger.info('[Redis] Connected successfully');
      logger.info('[RedisSingleton] Bootstrap connection confirmed (PONG)');
    } catch (err) {
      logger.error('[Redis] connect() failed', {
        error:   err.message,
        code:    err.code    || null,
        syscall: err.syscall || null,
      });
      logger.error('[RedisSingleton] Bootstrap connection failed', { error: err.message });
      throw err; // let bootstrap fail-fast in production
    }
  }

  let _quitting = false;

  async function quit() {
    if (_quitting) return;   // safe no-op on double-call (signal + server shutdown)
    _quitting = true;
    try {
      logger.info('[RedisSingleton] Shutting down…');
      await client.quit();
    } catch (err) {
      logger.error('[RedisSingleton] Shutdown error', { error: err?.message });
    }
  }

  // ── Shutdown handler (registered exactly once) ───────────────
  process.once('SIGTERM', () => quit().catch(() => {}));
  process.once('SIGINT',  () => quit().catch(() => {}));

  // ── isReady() — dual check: internal flag + ioredis client.status ──────────
  //
  // _ready is set by event listeners. Under race conditions (e.g. the 'error'
  // event fires synchronously during a command but before the listener runs)
  // _ready could still be true while client.status has already transitioned
  // away from 'ready'. Cross-checking client.status === 'ready' closes that gap.
  //
  // Performance: client.status is a simple string property read — O(1), no I/O.

  function isReady() {
    return _ready && client.status === 'ready';
  }

  // ── Unified cache API ────────────────────────────────────────
  // Mirrors the API contract of the old redisClient.js so existing
  // callers need zero changes to their call sites.

  async function get(key) {
    if (!isReady()) return null;
    try { return await client.get(key); }
    catch (err) { logger.warn('[RedisSingleton] GET failed', { key, error: err.message }); return null; }
  }

  async function set(key, value, ttlSeconds = 300) {
    if (!isReady()) return null;
    try { return await client.set(key, String(value), 'EX', ttlSeconds); }
    catch (err) { logger.warn('[RedisSingleton] SET failed', { key, error: err.message }); return null; }
  }

  async function del(...keys) {
    if (!isReady()) return 0;
    try { return await client.del(...keys); }
    catch (err) { logger.warn('[RedisSingleton] DEL failed', { keys, error: err.message }); return 0; }
  }

  /**
   * Atomic increment with TTL-on-first-write (standard rate-limit pattern).
   * Sets the TTL only when the counter transitions 0→1 to avoid resetting
   * the window on every subsequent increment.
   */
  async function incr(key, ttlSeconds = 60) {
    if (!isReady()) return 0;
    try {
      const newVal = await client.incr(key);
      if (newVal === 1) await client.expire(key, ttlSeconds);
      return newVal;
    } catch (err) {
      logger.warn('[RedisSingleton] INCR failed', { key, error: err.message });
      return 0;
    }
  }

  async function expire(key, ttlSeconds) {
    if (!isReady()) return 0;
    try { return await client.expire(key, ttlSeconds); }
    catch (err) { logger.warn('[RedisSingleton] EXPIRE failed', { key, error: err.message }); return 0; }
  }

  async function hget(hash, field) {
    if (!isReady()) return null;
    try { return await client.hget(hash, field); }
    catch (err) { logger.warn('[RedisSingleton] HGET failed', { hash, field, error: err.message }); return null; }
  }

  async function hset(hash, field, value, ttlSeconds = 300) {
    if (!isReady()) return null;
    try {
      await client.hset(hash, field, String(value));
      return client.expire(hash, ttlSeconds);
    } catch (err) {
      logger.warn('[RedisSingleton] HSET failed', { hash, field, error: err.message });
      return null;
    }
  }

  async function keys(pattern) {
    if (!isReady()) return [];
    try { return await client.keys(pattern); }
    catch (err) { logger.warn('[RedisSingleton] KEYS failed', { pattern, error: err.message }); return []; }
  }

  // ── safeExec — circuit-breaker-aware safe execution wrapper ────────────────
  //
  // SIGNATURE:
  //   safeExec(fn, fallbackValue = null, timeoutMs = 5_000)
  //
  //   fn            — async (client) => any
  //                   Receives the raw ioredis client as its argument.
  //                   Use for commands not exposed by the unified API above
  //                   (eval, publish, scan, pipeline, etc.)
  //
  //   fallbackValue — returned when:
  //                   (a) Redis is not ready → immediate return, no I/O
  //                   (b) Circuit is OPEN → immediate return, no I/O
  //                   (c) fn() throws or rejects
  //                   (d) timeoutMs is exceeded
  //                   Default: null
  //
  //   timeoutMs     — hard cap on fn() execution time.
  //                   Default: 5_000 ms
  //
  // GUARANTEES:
  //   - Never throws
  //   - Never hangs beyond timeoutMs
  //   - Logs all failures at warn level
  //   - Records latency for every call (success or failure)
  //   - Circuit breaker trips after REDIS_CB_FAILURE_THRESHOLD consecutive failures
  //
  // CIRCUIT BREAKER FLOW:
  //   CLOSED   → execute normally, record latency
  //   OPEN     → return fallbackValue immediately (no I/O, no log spam)
  //   HALF_OPEN → allow exactly one probe; success=CLOSE, failure=OPEN
  //
  // EXAMPLE USAGE (unchanged from Phase 3 — no call-site changes needed):
  //   const val = await redis.safeExec(c => c.get('session:abc'), null);
  //   const n   = await redis.safeExec(c => c.incr('counter'), 0);
  //   await redis.safeExec(c => c.publish('channel', payload));
  //   const count = await redis.safeExec(c => c.llen('queue'), 0, 2_000);

  async function safeExec(fn, fallbackValue = null, timeoutMs = 5_000) {
    // ── Gate 1: connection readiness ──────────────────────────
    if (!isReady()) return fallbackValue;

    // ── Gate 2: circuit breaker ───────────────────────────────
    // isOpen() also handles the CLOSED→HALF_OPEN transition on cooldown expiry.
    if (circuitBreaker.isOpen()) return fallbackValue;

    // Register the call (increments totalCalls; locks HALF_OPEN probe slot).
    circuitBreaker.beginCall();

    const start = Date.now();
    let tid;

    try {
      const result = await Promise.race([
        fn(client),
        new Promise((_, reject) => {
          tid = setTimeout(() => reject(new Error('REDIS_TIMEOUT')), timeoutMs);
        }),
      ]);

      clearTimeout(tid);
      circuitBreaker.recordSuccess(Date.now() - start);
      return result;

    } catch (err) {
      clearTimeout(tid);
      const latency = Date.now() - start;
      circuitBreaker.recordFailure(latency);
      logger.warn('[RedisSingleton] safeExec failed', {
        error:     err.message,
        latencyMs: latency,
        circuit:   circuitBreaker.getState(),
      });
      return fallbackValue;
    }
  }

  return Object.freeze({
    // lifecycle
    connect,
    quit,
    isReady,
    getClient: () => client,     // escape hatch for ioredis-specific APIs

    // unified API
    get,
    set,
    del,
    incr,
    expire,
    hget,
    hset,
    keys,
    safeExec,

    // Phase 4: expose circuit breaker for health endpoint
    circuitBreaker,
  });
}

// ─────────────────────────────────────────────────────────────
// EXPORT
// The module is evaluated once by Node's require cache.
// Every subsequent require() returns the same frozen object.
// ─────────────────────────────────────────────────────────────

const singleton = ENABLED ? buildLiveSingleton() : buildDisabledSingleton();

module.exports = singleton;