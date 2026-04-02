'use strict';

/**
 * src/modules/conversion/services/conversionAggregate.service.js
 *
 * Supabase-native conversion aggregate service.
 *
 * Responsibilities:
 * - reacts after raw event persistence
 * - triggers SQL-race-safe aggregate increment
 * - recomputes normalized intent scores
 * - invalidates cache after successful aggregate write
 * - exposes raw stored scores
 */

const conversionAggregateRepository = require('../repositories/conversionAggregate.repository');
const cacheProvider = require('../utils/conversionCache.provider');
const logger = require('../utils/conversion.logger');

const {
  ENGAGEMENT_WEIGHTS,
  MONETIZATION_WEIGHTS,
  DIMENSION_WEIGHTS,
  MAX_EVENT_REPETITIONS,
} = require('../utils/eventWeights.config');

class ConversionAggregateService {
  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Called after raw event is written.
   * Performs SQL-atomic counter increment + score recompute.
   *
   * @param {string} userId
   * @param {string} eventType
   */
  async onEventRecorded(userId, eventType) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      if (!eventType) {
        throw new Error('eventType is required');
      }

      await conversionAggregateRepository.incrementAndUpdate(
        userId,
        eventType,
        (_existingData, updatedCounts) => {
          const engagementScore = this._dimensionScore(
            updatedCounts,
            ENGAGEMENT_WEIGHTS
          );

          const monetizationScore = this._dimensionScore(
            updatedCounts,
            MONETIZATION_WEIGHTS
          );

          const totalIntentScore = Math.min(
            100,
            Math.round(
              engagementScore * DIMENSION_WEIGHTS.engagement +
              monetizationScore * DIMENSION_WEIGHTS.monetization
            )
          );

          return {
            engagementScore,
            monetizationScore,
            totalIntentScore,
            isEngagementEvent:
              ENGAGEMENT_WEIGHTS[eventType] != null,
            isMonetizationEvent:
              MONETIZATION_WEIGHTS[eventType] != null,
          };
        }
      );

      // invalidate cache only after successful aggregate persistence
      await cacheProvider.invalidateScores(userId);

      logger.debug('ConversionAggregateService.onEventRecorded success', {
        userId,
        eventType,
      });
    } catch (error) {
      logger.error(
        'ConversionAggregateService.onEventRecorded failed',
        {
          userId,
          eventType,
          error: error.message,
        }
      );
      throw error;
    }
  }

  /**
   * Returns stored raw scores (pre-decay).
   *
   * @param {string} userId
   * @returns {Promise<{
   *   engagementScore:number,
   *   monetizationScore:number,
   *   totalIntentScore:number,
   *   lastEventAt:string|null,
   *   lastEngagementEventAt:string|null,
   *   lastMonetizationEventAt:string|null
   * }>}
   */
  async getRawScores(userId) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      const aggregate =
        await conversionAggregateRepository.getAggregate(userId);

      if (!aggregate) {
        return this._emptyScores();
      }

      return {
        engagementScore: aggregate.engagement_score ?? 0,
        monetizationScore: aggregate.monetization_score ?? 0,
        totalIntentScore: aggregate.total_intent_score ?? 0,
        lastEventAt: aggregate.last_event_at ?? null,
        lastEngagementEventAt:
          aggregate.last_engagement_event_at ?? null,
        lastMonetizationEventAt:
          aggregate.last_monetization_event_at ?? null,
      };
    } catch (error) {
      logger.error('ConversionAggregateService.getRawScores failed', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Pure Scoring Logic
  // ---------------------------------------------------------------------------

  /**
   * Converts weighted event counts into normalized 0-100 score.
   *
   * @param {Record<string, number>} eventCounts
   * @param {Record<string, number>} weights
   * @returns {number}
   */
  _dimensionScore(eventCounts, weights) {
    let raw = 0;
    let maxRaw = 0;

    for (const [eventType, weight] of Object.entries(weights)) {
      const count = Math.min(
        Number(eventCounts?.[eventType] ?? 0),
        MAX_EVENT_REPETITIONS
      );

      raw += weight * count;
      maxRaw += weight * MAX_EVENT_REPETITIONS;
    }

    if (maxRaw === 0) {
      return 0;
    }

    return Math.min(100, Math.round((raw / maxRaw) * 100));
  }

  /**
   * Default score shape for missing users.
   */
  _emptyScores() {
    return {
      engagementScore: 0,
      monetizationScore: 0,
      totalIntentScore: 0,
      lastEventAt: null,
      lastEngagementEventAt: null,
      lastMonetizationEventAt: null,
    };
  }
}

module.exports = new ConversionAggregateService();