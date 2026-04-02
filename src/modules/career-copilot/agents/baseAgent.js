'use strict';

/**
 * src/modules/career-copilot/agents/baseAgent.js
 *
 * Abstract base class for all Career Copilot specialist agents.
 *
 * Responsibilities:
 * - Standardized execute(userId, context, opts) interface
 * - Redis caching via shared CacheManager singleton
 * - Structured non-throwing response envelope
 * - Agent-level failure isolation
 * - Consistent logging
 * - Cache invalidation support
 *
 * Subclasses MUST implement:
 *   get agentName()
 *   get cachePrefix()
 *   async run(userId, context)
 */

const cacheManager = require('../../../core/cache/cache.manager');
const logger = require('../../../utils/logger');

const CACHE_TTL_SECONDS = 600; // 10 minutes

class BaseAgent {
  constructor() {
    /**
     * Shared Redis client singleton.
     * Reused across requests for maximum connection efficiency.
     * @private
     */
    this._cache = cacheManager.getClient();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Abstract API
  // ─────────────────────────────────────────────────────────────────────────────

  /** @returns {string} */
  get agentName() {
    throw new Error(`${this.constructor.name} must implement agentName`);
  }

  /** @returns {string} */
  get cachePrefix() {
    throw new Error(`${this.constructor.name} must implement cachePrefix`);
  }

  /**
   * Subclass business logic.
   *
   * @param {string} userId
   * @param {object} context
   * @returns {Promise<object>}
   */
  async run(userId, context) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement run()`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Executes the agent with cache + fault isolation.
   * This method NEVER throws.
   *
   * @param {string} userId
   * @param {object} context
   * @param {{ forceRefresh?: boolean }} opts
   * @returns {Promise<{
   *   agent: string,
   *   output: object | null,
   *   cached: boolean,
   *   duration_ms: number,
   *   error?: string
   * }>}
   */
  async execute(userId, context = {}, opts = {}) {
    const forceRefresh = opts?.forceRefresh === true;
    const cacheKey = this._buildCacheKey(userId);
    const startMs = Date.now();

    // ── Cache read ────────────────────────────────────────────────────────────
    if (!forceRefresh) {
      const cached = await this._safeGetCache(cacheKey);

      if (cached !== null) {
        logger.debug(`[${this.agentName}] Cache hit`, {
          userId,
          cacheKey,
        });

        return {
          agent: this.agentName,
          output: cached,
          cached: true,
          duration_ms: Date.now() - startMs,
        };
      }
    }

    // ── Run agent safely ──────────────────────────────────────────────────────
    try {
      logger.info(`[${this.agentName}] Running`, { userId });

      const output = await this.run(userId, context ?? {});

      await this._safeSetCache(cacheKey, output);

      const duration = Date.now() - startMs;

      logger.info(`[${this.agentName}] Done`, {
        userId,
        duration_ms: duration,
      });

      return {
        agent: this.agentName,
        output,
        cached: false,
        duration_ms: duration,
      };
    } catch (err) {
      const duration = Date.now() - startMs;
      const message = err instanceof Error ? err.message : 'Unknown agent failure';

      logger.error(`[${this.agentName}] Failed`, {
        userId,
        duration_ms: duration,
        error: message,
      });

      return {
        agent: this.agentName,
        output: null,
        cached: false,
        duration_ms: duration,
        error: message,
      };
    }
  }

  /**
   * Removes cached result for a single user.
   *
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async invalidateCache(userId) {
    const cacheKey = this._buildCacheKey(userId);

    try {
      if (!this._cache) return;
      await this._cache.del(cacheKey);
    } catch (err) {
      logger.warn(`[${this.agentName}] Cache invalidation failed`, {
        userId,
        cacheKey,
        error: err instanceof Error ? err.message : 'Unknown cache error',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * @private
   * @param {string} userId
   * @returns {string}
   */
  _buildCacheKey(userId) {
    return `${this.cachePrefix}:${String(userId)}`;
  }

  /**
   * Safe cache read with JSON parsing protection.
   *
   * @private
   * @param {string} key
   * @returns {Promise<object | null>}
   */
  async _safeGetCache(key) {
    try {
      if (!this._cache) return null;

      const raw = await this._cache.get(key);
      if (!raw) return null;

      return JSON.parse(raw);
    } catch (err) {
      logger.warn(`[${this.agentName}] Cache read failed`, {
        cacheKey: key,
        error: err instanceof Error ? err.message : 'Unknown cache error',
      });

      return null;
    }
  }

  /**
   * Safe cache write.
   *
   * @private
   * @param {string} key
   * @param {object} value
   * @returns {Promise<void>}
   */
  async _safeSetCache(key, value) {
    try {
      if (!this._cache || value == null) return;

      await this._cache.set(
        key,
        JSON.stringify(value),
        'EX',
        CACHE_TTL_SECONDS
      );
    } catch (err) {
      logger.warn(`[${this.agentName}] Cache write failed`, {
        cacheKey: key,
        error: err instanceof Error ? err.message : 'Unknown cache error',
      });
    }
  }
}

module.exports = BaseAgent;