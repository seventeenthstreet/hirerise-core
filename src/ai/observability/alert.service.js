'use strict';

/**
 * src/ai/observability/alert.service.js  — Phase 2 Refactor / Phase 3 Fix
 *
 * CHANGES (Phase 2):
 *  - Accepts an optional ioredis client via constructor (DI)
 *  - Removed _initRedis() — no new Redis connections created here
 *  - _useRedis getter delegates to ioredis client.status (synchronous)
 *  - close() is now a no-op — lifecycle is the singleton's responsibility
 *  - Business logic (fire, checkLatency, checkTokenSpike, dedup) UNCHANGED
 *
 * PHASE 3 FIX — bootstrap ordering:
 *  Root cause: ai-observability.routes.js is require()'d at module parse time
 *  (server.js line ~4933, before bootstrap() runs). This caused buildSingleton()
 *  to execute before await connectRedis(), capturing a null Redis client that
 *  was then frozen in Node's module cache permanently.
 *
 *  Fix: _redisClient is now a lazy getter that reads from redis.singleton on
 *  every access. The singleton is always ready by the time any real operation
 *  runs (post-bootstrap), so the getter finds it connected. No call-site changes.
 *  The constructor no longer accepts or stores an injected client — the DI
 *  indirection is replaced by direct singleton resolution, which is simpler and
 *  immune to require-order races.
 *
 * EXPORTS: singleton instance. Callers unchanged.
 */

const observabilityRepo = require('../../repositories/ai-observability.repository');
const logger            = require('../../utils/logger');

const COOLDOWN_SECONDS = 3600; // 1 hour
const ALERT_KEY_PREFIX = 'hirerise:alert_cooldown:';

class AlertService {
  constructor() {
    this._localCache = new Map();
    // _redisClient is resolved lazily via getter — see below.
    // Logging deferred to first _useRedis check so it reflects actual readiness.
  }

  // ─────────────────────────────────────────────
  // READY HELPER
  // ─────────────────────────────────────────────

  /**
   * Lazily resolves the connected Redis client from the canonical module.
   *
   * WHY LAZY: This module may be require()'d before bootstrap() calls
   * await connectRedis() (e.g. via route files loaded at parse time).
   * Capturing the client at construction time would freeze a null reference.
   * Reading from redisClient on each access means we always get the live
   * client once Redis is ready, with no module-cache races.
   *
   * Cost: one require() call (returns cached module object) + one property
   * read per _redisClient access. Both are O(1) and negligible.
   *
   * @returns {import('ioredis').Redis | null}
   */
  get _redisClient() {
    try {
      const redisClient = require('../../config/redisClient');
      return redisClient.getRedisClient?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * True only when the singleton client is present and connected.
   * ioredis exposes readiness via client.status.
   */
  get _useRedis() {
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
 * Singleton export — no Redis client injection needed.
 * The instance resolves Redis lazily via the _redisClient getter on every
 * operation, so it is always correct regardless of when this module is first
 * require()'d relative to bootstrap().
 */
module.exports = new AlertService();