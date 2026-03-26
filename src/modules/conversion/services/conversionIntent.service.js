'use strict';

/**
 * conversionIntent.service.js
 *
 * Returns time-decayed intent scores.
 *
 * - Uses Redis cache
 * - Applies dimension-specific exponential decay
 * - Recomputes total from decayed dimensions
 * - Prevents cache stampede
 */

const conversionAggregateService = require('./conversionAggregate.service');
const cacheProvider = require('../utils/conversionCache.provider');

const {
  DIMENSION_WEIGHTS,
  ENGAGEMENT_DECAY_WINDOW_DAYS,
  MONETIZATION_DECAY_WINDOW_DAYS,
} = require('../utils/eventWeights.config');

const logger = require('../utils/conversion.logger');

class ConversionIntentService {

  constructor() {
    // Prevent cache stampede
    this._inFlight = new Map();
  }

  /**
   * Returns decayed scores for user.
   */
  async getScores(userId) {

    // 1️⃣ Cache hit
    const cached = await cacheProvider.getScores(userId);
    if (cached) {
      logger.debug('conversionIntentService: cache hit', { userId });
      return cached;
    }

    // 2️⃣ Prevent duplicate parallel recomputation
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
  }

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

    logger.debug('conversionIntentService: computed + cached', {
      userId,
      decayed,
    });

    return decayed;
  }

  /**
   * Applies dimension-specific decay.
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
        decayedEngagement   * DIMENSION_WEIGHTS.engagement +
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
   * Exponential decay factor.
   */
  _decayFactor(lastEventAt, windowDays) {
    if (!lastEventAt) return 1;

    const msPerDay = 86_400_000;
    const daysSince = (Date.now() - lastEventAt.getTime()) / msPerDay;

    const clamped = Math.max(0, daysSince);

    return Math.exp(-clamped / windowDays);
  }
}

module.exports = new ConversionIntentService();








