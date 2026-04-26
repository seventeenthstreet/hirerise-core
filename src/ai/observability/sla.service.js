'use strict';

/**
 * src/ai/observability/sla.service.js  — Phase 2 Refactor
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
 * WIRING (composition root):
 *   const slaService = new SlaService(redisSingleton.getClient());
 */

const observabilityRepo = require('../../repositories/ai-observability.repository');
const logger            = require('../../utils/logger');

const SLA_CACHE_PREFIX = 'hirerise:sla:';
const SLA_CACHE_TTL    = 3600; // 1 hour

class SlaService {
  /**
   * @param {import('ioredis').Redis | null} redisClient
   *   Injected, already-connected ioredis client from the singleton.
   *   Pass null to disable Redis-backed SLA caching (DB-only mode).
   *   When null, _useRedis will attempt a lazy resolution from
   *   redis.singleton on first access (post-bootstrap safe).
   */
  constructor(redisClient = null) {
    this._redisClient = redisClient || null;

    if (this._redisClient) {
      logger.info('[SlaService] Initialized with injected Redis client');
    } else {
      logger.info('[SlaService] No Redis client — will upgrade lazily once Redis is ready');
    }
  }

  // ─────────────────────────────────────────────
  // READY HELPER
  // ─────────────────────────────────────────────

  /**
   * True only when an ioredis client is present and status === 'ready'.
   *
   * Lazy upgrade path: if this instance was constructed before Redis
   * connected (required at module-parse time), this getter attempts to
   * resolve the client from redis.singleton on every call until it
   * succeeds.  Once resolved the reference is stored permanently.
   */
  get _useRedis() {
    // Fast path — already wired.
    if (this._redisClient && this._redisClient.status === 'ready') return true;

    // Lazy upgrade — attempt to resolve from singleton.
    if (!this._redisClient) {
      try {
        const redisSingleton = require('../../infrastructure/radis/redis.singleton');
        if (redisSingleton && redisSingleton.isReady()) {
          this._redisClient = redisSingleton.getClient();
          logger.info('[SlaService] Lazily upgraded to Redis client (post-bootstrap)');
        }
      } catch (_) {
        // singleton not available (test env) — remain in DB-only mode
      }
    }

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
 * Lazy singleton — resolves Redis client from the singleton on first require()
 * after bootstrap. Preserves the existing call pattern:
 *   const slaService = require('...sla.service');
 *   await slaService.evaluateDailySLA(date);
 */
function buildSingleton() {
  try {
    const redisSingleton = require('../../infrastructure/radis/redis.singleton');
    const client = redisSingleton.isReady() ? redisSingleton.getClient() : null;
    return new SlaService(client);
  } catch (_) {
    return new SlaService(null);
  }
}

module.exports = buildSingleton();