'use strict';

/**
 * src/ai/observability/alert.service.js  — Phase 2 Refactor
 *
 * CHANGES (Phase 2):
 *  - Accepts an optional ioredis client via constructor (DI)
 *  - Removed _initRedis() — no new Redis connections created here
 *  - _useRedis getter delegates to ioredis client.status (synchronous)
 *  - close() is now a no-op — lifecycle is the singleton's responsibility
 *  - Business logic (fire, checkLatency, checkTokenSpike, dedup) UNCHANGED
 *
 * EXPORTS: singleton instance wired lazily from redis.singleton.
 * Callers continue to require() and call methods directly — no changes needed.
 */

const observabilityRepo = require('../../repositories/ai-observability.repository');
const logger            = require('../../utils/logger');

const COOLDOWN_SECONDS = 3600; // 1 hour
const ALERT_KEY_PREFIX = 'hirerise:alert_cooldown:';

class AlertService {
  /**
   * @param {import('ioredis').Redis | null} redisClient
   *   Injected, already-connected ioredis client from the singleton.
   *   Pass null (or omit) to disable Redis-backed deduplication.
   *   When null, the first call to _useRedis will attempt a lazy
   *   resolution from redis.singleton (post-bootstrap safe).
   */
  constructor(redisClient = null) {
    this._localCache  = new Map();
    this._redisClient = redisClient || null;

    if (this._redisClient) {
      logger.info('[AlertService] Redis deduplication active (injected client)');
    } else {
      logger.info('[AlertService] Using local (in-process) deduplication — will upgrade lazily once Redis is ready');
    }
  }

  // ─────────────────────────────────────────────
  // READY HELPER
  // ─────────────────────────────────────────────

  /**
   * True only when an ioredis client is present and status === 'ready'.
   *
   * Lazy upgrade path: if this instance was constructed before Redis
   * connected (e.g. required at module-parse time), this getter attempts
   * to resolve the client from redis.singleton on every call until it
   * succeeds.  Once resolved the reference is stored permanently on
   * this._redisClient so subsequent calls are a single property read.
   */
  get _useRedis() {
    // Fast path — already wired.
    if (this._redisClient && this._redisClient.status === 'ready') return true;

    // Lazy upgrade — attempt to resolve from singleton now that Redis
    // may have connected during bootstrap.
    if (!this._redisClient) {
      try {
        const redisSingleton = require('../../infrastructure/radis/redis.singleton');
        if (redisSingleton && redisSingleton.isReady()) {
          this._redisClient = redisSingleton.getClient();
          logger.info('[AlertService] Lazily upgraded to Redis client (post-bootstrap)');
        }
      } catch (_) {
        // singleton not available (test env) — remain in local-cache mode
      }
    }

    return !!(this._redisClient && this._redisClient.status === 'ready');
  }

  // ─────────────────────────────────────────────
  // MAIN ALERT METHOD
  // ─────────────────────────────────────────────

  async fire(params) {
    const {
      type,
      feature,
      severity,
      title,
      detail,
      model         = null,
      correlationId = null,
    } = params;

    if (!this._validateAlert(params)) return null;

    const dedupeKey = `${type}:${feature}:${severity}:${model || 'na'}:${process.env.NODE_ENV || 'dev'}`;

    const allowed = await this._trySetCooldown(dedupeKey);
    if (!allowed) return null;

    const alertEntry = {
      type,
      feature,
      severity,
      title,
      detail: detail || {},
      model,
      correlationId,
      environment: process.env.NODE_ENV || 'development',
    };

    // Timeout protection around DB write
    const alertId = await Promise.race([
      observabilityRepo.writeAlert(alertEntry),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000)
      ),
    ]).catch((err) => {
      logger.error('[AlertService] Persist failed', { error: err.message });
      return null;
    });

    this._notifyAdmin({ ...alertEntry, alertId }).catch(() => {});

    logger.warn('[ALERT]', { type, feature, severity, title });

    return alertId;
  }

  // ─────────────────────────────────────────────
  // ALERT CHECKS
  // ─────────────────────────────────────────────

  async checkLatency(feature, latencyMs, model, correlationId) {
    const { latency } = require('../../config/observability.config');

    if (latencyMs >= latency.p95CriticalMs) {
      return this.fire({
        type: 'LATENCY', feature, severity: 'CRITICAL',
        title: `Critical latency breach: ${latencyMs}ms`,
        detail: { latencyMs, threshold: latency.p95CriticalMs },
        model, correlationId,
      });
    }

    if (latencyMs >= latency.p95WarningMs) {
      return this.fire({
        type: 'LATENCY', feature, severity: 'WARNING',
        title: `Latency warning: ${latencyMs}ms`,
        detail: { latencyMs, threshold: latency.p95WarningMs },
        model, correlationId,
      });
    }
  }

  async checkTokenSpike(feature, totalTokens, model, correlationId) {
    const { tokens } = require('../../config/observability.config');

    if (totalTokens >= tokens.absoluteSpikeThreshold) {
      return this.fire({
        type: 'TOKEN_SPIKE', feature, severity: 'WARNING',
        title: `Token spike: ${totalTokens}`,
        detail: { totalTokens, threshold: tokens.absoluteSpikeThreshold },
        model, correlationId,
      });
    }
  }

  // ─────────────────────────────────────────────
  // DEDUP (ATOMIC)
  // ─────────────────────────────────────────────

  async _trySetCooldown(key) {
    if (this._useRedis) {
      try {
        const result = await this._redisClient.set(
          `${ALERT_KEY_PREFIX}${key}`,
          '1',
          'NX',
          'EX',
          COOLDOWN_SECONDS
        );
        return result === 'OK'; // true = first caller wins
      } catch {
        return this._localTrySetCooldown(key);
      }
    }

    return this._localTrySetCooldown(key);
  }

  _localTrySetCooldown(key) {
    const now  = Date.now();
    const last = this._localCache.get(key);

    if (last && now - last < COOLDOWN_SECONDS * 1000) {
      return false;
    }

    this._localCache.set(key, now);

    // Prune stale entries to avoid unbounded growth
    if (this._localCache.size > 1000) {
      const cutoff = now - COOLDOWN_SECONDS * 1000;
      for (const [k, v] of this._localCache.entries()) {
        if (v < cutoff) this._localCache.delete(k);
      }
    }

    return true;
  }

  // ─────────────────────────────────────────────
  // VALIDATION
  // ─────────────────────────────────────────────

  _validateAlert({ type, feature, severity, title }) {
    const validTypes = [
      'LATENCY', 'ERROR_RATE', 'DRIFT', 'TOKEN_SPIKE', 'BUDGET',
      'SLA_BREACH', 'CIRCUIT_BREAKER', 'CALIBRATION',
    ];

    const validSeverities = ['WARNING', 'CRITICAL'];

    return (
      validTypes.includes(type) &&
      validSeverities.includes(severity) &&
      !!feature &&
      !!title
    );
  }

  // ─────────────────────────────────────────────
  // NOTIFICATION
  // ─────────────────────────────────────────────

  async _notifyAdmin(alert) {
    if (process.env.NODE_ENV === 'test') return;

    if (process.env.NODE_ENV !== 'production') {
      logger.info('[AlertService] Notification', { subject: alert.title });
    }

    // plug: email / slack later
  }

  // ─────────────────────────────────────────────
  // SHUTDOWN
  // ─────────────────────────────────────────────

  /**
   * No-op in Phase 2.
   * Redis lifecycle (quit/close) is managed exclusively by the singleton.
   */
  async close() {
    // intentionally empty — do not quit the shared singleton client
  }
}

/**
 * Lazy singleton — resolves Redis client from the singleton on first require()
 * after bootstrap. Preserves the existing call pattern:
 *   const alertService = require('...alert.service');
 *   alertService.fire({ ... });
 */
function buildSingleton() {
  try {
    const redisSingleton = require('../../infrastructure/radis/redis.singleton');
    const client = redisSingleton.isReady() ? redisSingleton.getClient() : null;
    return new AlertService(client);
  } catch (_) {
    return new AlertService(null);
  }
}

module.exports = buildSingleton();