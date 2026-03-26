'use strict';

/**
 * conversionAggregate.service.js
 *
 * Computes engagement and monetization scores safely inside Firestore transactions.
 * No raw event scans.
 * No pre-transaction score computation.
 */

const conversionAggregateRepository = require('../repositories/conversionAggregate.repository');
const cacheProvider = require('../utils/conversionCache.provider');

const {
  ENGAGEMENT_WEIGHTS,
  MONETIZATION_WEIGHTS,
  DIMENSION_WEIGHTS,
  MAX_EVENT_REPETITIONS,
} = require('../utils/eventWeights.config');

const logger = require('../utils/conversion.logger');

class ConversionAggregateService {

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Called after raw event is written.
   * Performs atomic counter increment + score recompute.
   */
  async onEventRecorded(userId, eventType) {
    try {
      await conversionAggregateRepository.incrementAndUpdate(
        userId,
        eventType,
        (existingData, updatedCounts) => {

          const engagementScore   = this._dimensionScore(updatedCounts, ENGAGEMENT_WEIGHTS);
          const monetizationScore = this._dimensionScore(updatedCounts, MONETIZATION_WEIGHTS);

          const totalIntentScore = Math.min(
            100,
            Math.round(
              engagementScore   * DIMENSION_WEIGHTS.engagement +
              monetizationScore * DIMENSION_WEIGHTS.monetization
            )
          );

          return {
            engagementScore,
            monetizationScore,
            totalIntentScore,
            isEngagementEvent: ENGAGEMENT_WEIGHTS[eventType] != null,
            isMonetizationEvent: MONETIZATION_WEIGHTS[eventType] != null,
          };
        }
      );

      // Invalidate cache AFTER successful transaction
      await cacheProvider.invalidateScores(userId);

      logger.debug('ConversionAggregateService.onEventRecorded', {
        userId,
        eventType,
      });

    } catch (err) {
      logger.error('ConversionAggregateService.onEventRecorded failed', {
        userId,
        eventType,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Returns stored (pre-decay) scores.
   */
  async getRawScores(userId) {
    const aggregate = await conversionAggregateRepository.getAggregate(userId);

    if (!aggregate) {
      return {
        engagementScore: 0,
        monetizationScore: 0,
        totalIntentScore: 0,
        lastEventAt: null,
        lastEngagementEventAt: null,
        lastMonetizationEventAt: null,
      };
    }

    return {
      engagementScore: aggregate.engagementScore ?? 0,
      monetizationScore: aggregate.monetizationScore ?? 0,
      totalIntentScore: aggregate.totalIntentScore ?? 0,
      lastEventAt: aggregate.lastEventAt?.toDate?.() ?? null,
      lastEngagementEventAt: aggregate.lastEngagementEventAt?.toDate?.() ?? null,
      lastMonetizationEventAt: aggregate.lastMonetizationEventAt?.toDate?.() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Pure Scoring Logic
  // ---------------------------------------------------------------------------

  _dimensionScore(eventCounts, weights) {
    let raw = 0;
    let maxRaw = 0;

    for (const [eventType, weight] of Object.entries(weights)) {
      const count = Math.min(
        eventCounts[eventType] ?? 0,
        MAX_EVENT_REPETITIONS
      );

      raw += weight * count;
      maxRaw += weight * MAX_EVENT_REPETITIONS;
    }

    if (maxRaw === 0) return 0;

    return Math.min(100, Math.round((raw / maxRaw) * 100));
  }
}

module.exports = new ConversionAggregateService();








