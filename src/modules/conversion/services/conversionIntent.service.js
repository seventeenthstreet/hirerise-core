'use strict';

/**
 * src/modules/conversion/services/conversionIntent.service.js
 *
 * Returns time-decayed intent scores.
 *
 * Architecture:
 * - Redis cache
 * - in-flight request coalescing
 * - dimension-specific exponential decay
 * - Supabase TIMESTAMPTZ ISO string safe
 * - cache stampede prevention
 */

const conversionAggregateService = require('./conversionAggregate.service');
const cacheProvider = require('../utils/conversionCache.provider');
const logger = require('../utils/conversion.logger');

const {
  DIMENSION_WEIGHTS,
  ENGAGEMENT_DECAY_WINDOW_DAYS,
  MONETIZATION_DECAY_WINDOW_DAYS,
} = require('../utils/eventWeights.config');

const MS_PER_DAY = 86_400_000;

class ConversionIntentService {
  constructor() {
    // Prevent cache stampede / duplicate recomputation
    this._inFlight = new Map();
  }

  /**
   * Returns decayed scores for a user.
   *
   * @param {string} userId
   * @returns {Promise<{
   *   engagementScore:number,
   *   monetizationScore:number,
   *   totalIntentScore:number
   * }>}
   */
  async getScores(userId) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      // 1) cache hit
      const cached = await cacheProvider.getScores(userId);

      if (cached) {
        logger.debug('conversionIntentService cache hit', {
          userId,
        });
        return cached;
      }

      // 2) prevent duplicate parallel recomputation
      if (this._inFlight.has(userId)) {
        return this._inFlight.get(userId);
      }

      const promise = this._computeAndCache(userId);
      this._inFlight.set(userId, promise);

      try {
        return await promise;
      } finally {
        this._inFlight.delete(userId);
      }
    } catch (error) {
      logger.error('conversionIntentService.getScores failed', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Returns only total intent score.
   *
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async getTotalIntentScore(userId) {
    const scores = await this.getScores(userId);
    return scores.totalIntentScore;
  }

  // ---------------------------------------------------------------------------
  // Internal Computation
  // ---------------------------------------------------------------------------

  async _computeAndCache(userId) {
    const raw = await conversionAggregateService.getRawScores(userId);

    const decayed = this._applyDecay(raw);

    await cacheProvider.setScores(userId, decayed);

    logger.debug('conversionIntentService computed and cached', {
      userId,
      decayed,
    });

    return decayed;
  }

  /**
   * Applies dimension-specific exponential decay.
   *
   * @param {{
   *   engagementScore:number,
   *   monetizationScore:number,
   *   lastEngagementEventAt:string|null,
   *   lastMonetizationEventAt:string|null
   * }} raw
   */
  _applyDecay(raw) {
    const engagementFactor = this._decayFactor(
      raw.lastEngagementEventAt,
      ENGAGEMENT_DECAY_WINDOW_DAYS
    );

    const monetizationFactor = this._decayFactor(
      raw.lastMonetizationEventAt,
      MONETIZATION_DECAY_WINDOW_DAYS
    );

    const decayedEngagement = Math.max(
      0,
      Math.round(raw.engagementScore * engagementFactor)
    );

    const decayedMonetization = Math.max(
      0,
      Math.round(raw.monetizationScore * monetizationFactor)
    );

    const decayedTotal = Math.min(
      100,
      Math.round(
        decayedEngagement * DIMENSION_WEIGHTS.engagement +
        decayedMonetization * DIMENSION_WEIGHTS.monetization
      )
    );

    return {
      engagementScore: decayedEngagement,
      monetizationScore: decayedMonetization,
      totalIntentScore: decayedTotal,
    };
  }

  /**
   * Exponential decay factor from ISO timestamp.
   *
   * @param {string|null} lastEventAt
   * @param {number} windowDays
   * @returns {number}
   */
  _decayFactor(lastEventAt, windowDays) {
    if (!lastEventAt) {
      return 1;
    }

    const timestamp = new Date(lastEventAt).getTime();

    if (Number.isNaN(timestamp)) {
      logger.warn(
        'conversionIntentService invalid timestamp for decay',
        {
          lastEventAt,
        }
      );
      return 1;
    }

    const daysSince = (Date.now() - timestamp) / MS_PER_DAY;
    const clampedDays = Math.max(0, daysSince);

    return Math.exp(-clampedDays / windowDays);
  }
}

module.exports = new ConversionIntentService();