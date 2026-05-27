'use strict';

/**
 * src/ai/observability/sla.service.js  — Phase 2 Refactor / Phase 3 Fix
 *
 * CHANGES (Phase 2):
 *  - Class renamed to SlaService (was erroneously named AlertService in
 *    the on-disk copy which was a corrupt duplicate of alert.service.js)
 *  - Accepts an optional ioredis client via constructor (DI)
 *  - Removed all _initRedis() / ioredis creation logic
 *  - Provides the SLA-specific API: evaluateDailySLA() + getSLAStatus()
 *  - Redis is used for caching SLA window data; falls back to DB-only reads
 *  - close() is now a no-op — lifecycle is the singleton's responsibility
 *
 * PHASE 3 FIX — bootstrap ordering:
 *  Root cause: same as alert.service.js — buildSingleton() was firing at
 *  require() time (before bootstrap's await connectRedis()) because
 *  ai-observability.routes.js is loaded at server.js parse time.
 *
 *  Fix: _redisClient is now a lazy getter that reads from redis.singleton on
 *  every access. No constructor injection; no module-cache race. The singleton
 *  is always connected by the time any real SLA operation is triggered.
 */

const observabilityRepo = require('../../repositories/ai-observability.repository');
const logger            = require('../../utils/logger');

const SLA_CACHE_PREFIX = 'hirerise:sla:';
const SLA_CACHE_TTL    = 3600; // 1 hour

class SlaService {
  constructor() {
    // _redisClient is resolved lazily via getter — no client injection needed.
    // See getter below for rationale.
  }

  // ─────────────────────────────────────────────
  // READY HELPER
  // ─────────────────────────────────────────────

  /**
   * Lazily resolves the connected Redis client from the canonical module.
   *
   * WHY LAZY: sla.service may be require()'d before bootstrap() calls
   * await connectRedis(). Capturing the client at construction time would
   * freeze a null reference. Reading from redisClient on each access means
   * we always see the live client once Redis is ready — no timing dependency.
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

  get _useRedis() {
    return !!(this._redisClient && this._redisClient.status === 'ready');
  }

  // ─────────────────────────────────────────────
  // SLA EVALUATION
  // ─────────────────────────────────────────────

  /**
   * Evaluates SLA compliance for a given date.
   * Called by sla-evaluation.worker.js on a daily cron.
   *
   * @param {string} targetDate  ISO date string, e.g. "2026-04-25"
   * @returns {Promise<Array>}   Array of SLA breach records
   */
  async evaluateDailySLA(targetDate) {
    logger.info('[SlaService] Evaluating daily SLA', { targetDate });

    try {
      const breaches = await observabilityRepo.getDailySLABreaches(targetDate);

      // Cache result in Redis for quick retrieval by getSLAStatus()
      if (this._useRedis && breaches) {
        const cacheKey = `${SLA_CACHE_PREFIX}daily:${targetDate}`;
        await this._redisClient
          .set(cacheKey, JSON.stringify(breaches), 'EX', SLA_CACHE_TTL)
          .catch((err) =>
            logger.warn('[SlaService] Cache write failed', { error: err.message })
          );
      }

      return breaches || [];
    } catch (err) {
      logger.error('[SlaService] evaluateDailySLA failed', {
        targetDate,
        error: err.message,
      });
      return [];
    }
  }

  /**
   * Returns SLA status summary for the last N days.
   * Used by the admin AI-observability route.
   *
   * @param {{ days?: number }} options
   * @returns {Promise<Object>}
   */
  async getSLAStatus({ days = 7 } = {}) {
    const cacheKey = `${SLA_CACHE_PREFIX}status:${days}d`;

    // Try Redis cache first
    if (this._useRedis) {
      try {
        const cached = await this._redisClient.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (err) {
        logger.warn('[SlaService] Cache read failed', { error: err.message });
      }
    }

    // Fallback: query DB directly
    try {
      const status = await observabilityRepo.getSLASummary({ days });

      // Populate cache
      if (this._useRedis && status) {
        await this._redisClient
          .set(cacheKey, JSON.stringify(status), 'EX', SLA_CACHE_TTL)
          .catch((err) =>
            logger.warn('[SlaService] Cache write failed', { error: err.message })
          );
      }

      return status || {};
    } catch (err) {
      logger.error('[SlaService] getSLAStatus failed', { days, error: err.message });
      return {};
    }
  }

  // ─────────────────────────────────────────────
  // SHUTDOWN
  // ─────────────────────────────────────────────

  /**
   * No-op in Phase 2.
   * Redis lifecycle is managed exclusively by the singleton.
   */
  async close() {
    // intentionally empty
  }
}

/**
 * Singleton export — no Redis client injection needed.
 * The instance resolves Redis lazily via the _redisClient getter on every
 * operation, so it is always correct regardless of when this module is first
 * require()'d relative to bootstrap().
 */
module.exports = new SlaService();