'use strict';

/**
 * baseAgent.js — Abstract Base Agent
 *
 * All five specialist agents extend this class.
 *
 * Provides:
 *   - Standard execute(userId, context, opts) interface
 *   - Redis caching via the existing CacheManager (10-min TTL)
 *   - Structured output envelope: { agent, output, cached, duration_ms, error }
 *   - Graceful isolation: agent failures never propagate to coordinator
 *   - Consistent logging format
 *
 * Subclasses MUST implement:
 *   get agentName()    — human name e.g. 'SkillIntelligenceAgent'
 *   get cachePrefix()  — Redis prefix e.g. 'agent:skill'
 *   async run(userId, context) — calls engines, returns structured output
 *
 * File location: src/modules/career-copilot/agents/baseAgent.js
 *
 * @module src/modules/career-copilot/agents/baseAgent
 */

const cacheManager = require('../../../core/cache/cache.manager');
const logger       = require('../../../utils/logger');

const CACHE_TTL_SECONDS = 600; // 10 minutes — matches platform TTL standard

class BaseAgent {
  constructor() {
    this._cache = cacheManager.getClient();
  }

  // ── Abstract — subclasses must implement ─────────────────────────────────────

  /** @returns {string} */
  get agentName() { throw new Error(`${this.constructor.name} must implement agentName`); }

  /** @returns {string} Redis key prefix */
  get cachePrefix() { throw new Error(`${this.constructor.name} must implement cachePrefix`); }

  /**
   * Core agent logic — calls its assigned engine(s) and returns structured output.
   * @param {string} userId
   * @param {object} context — user profile data passed by coordinator
   * @returns {Promise<object>}
   */
  async run(userId, context) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement run()`);
  }

  // ── Public interface ──────────────────────────────────────────────────────────

  /**
   * Execute this agent with caching and error isolation.
   * ALWAYS resolves — never rejects. Failures return { output: null, error }.
   *
   * @param {string} userId
   * @param {object} context
   * @param {{ forceRefresh?: boolean }} opts
   * @returns {Promise<AgentResult>}
   */
  async execute(userId, context = {}, opts = {}) {
    const { forceRefresh = false } = opts;
    const cacheKey = `${this.cachePrefix}:${userId}`;
    const startMs  = Date.now();

    // ── Cache check ────────────────────────────────────────────────────────────
    if (!forceRefresh) {
      try {
        const hit = await this._cache.get(cacheKey);
        if (hit) {
          logger.debug(`[${this.agentName}] Cache hit`, { userId });
          return {
            agent:       this.agentName,
            output:      JSON.parse(hit),
            cached:      true,
            duration_ms: Date.now() - startMs,
          };
        }
      } catch (_) { /* cache miss — proceed to run */ }
    }

    // ── Run engine ─────────────────────────────────────────────────────────────
    try {
      logger.info(`[${this.agentName}] Running`, { userId });

      const output = await this.run(userId, context);

      // Persist to cache
      try {
        await this._cache.set(cacheKey, JSON.stringify(output), 'EX', CACHE_TTL_SECONDS);
      } catch (_) { /* non-fatal */ }

      logger.info(`[${this.agentName}] Done`, {
        userId, duration_ms: Date.now() - startMs,
      });

      return {
        agent:       this.agentName,
        output,
        cached:      false,
        duration_ms: Date.now() - startMs,
      };

    } catch (err) {
      logger.error(`[${this.agentName}] Failed`, { userId, err: err.message });

      return {
        agent:       this.agentName,
        output:      null,
        cached:      false,
        duration_ms: Date.now() - startMs,
        error:       err.message,
      };
    }
  }

  /**
   * Remove this agent's cached output for a specific user.
   * Called by coordinator on forceRefresh or after profile update.
   */
  async invalidateCache(userId) {
    try {
      await this._cache.del(`${this.cachePrefix}:${userId}`);
    } catch (_) {}
  }
}

module.exports = BaseAgent;









