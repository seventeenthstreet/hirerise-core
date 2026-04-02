'use strict';

/**
 * src/modules/conversion/services/conversionEvent.service.js
 *
 * Responsibilities:
 *  1. Validate eventType
 *  2. Raw event audit write (SQL dedupe-safe)
 *  3. Fire-and-forget aggregate update
 *
 * NOTE:
 * Database unique partial index is source of truth for deduplication.
 * No application-side duplicate reads in critical write path.
 */

const conversionEventRepository = require('../repositories/conversionEvent.repository');
const conversionAggregateService = require('./conversionAggregate.service');
const logger = require('../utils/conversion.logger');

const {
  ENGAGEMENT_WEIGHTS,
  MONETIZATION_WEIGHTS,
} = require('../utils/eventWeights.config');

class ConversionEventService {
  constructor() {
    this._allowedEvents = new Set([
      ...Object.keys(ENGAGEMENT_WEIGHTS),
      ...Object.keys(MONETIZATION_WEIGHTS),
    ]);
  }

  /**
   * Records a conversion event safely.
   *
   * @param {string} userId
   * @param {string} eventType
   * @param {Record<string, unknown>} metadata
   * @param {string|null} idempotencyKey
   *
   * @returns {Promise<{ recorded: boolean, eventId: string|null }>}
   */
  async recordEvent(
    userId,
    eventType,
    metadata = {},
    idempotencyKey = null
  ) {
    try {
      if (!userId || !eventType) {
        throw new Error(
          'conversionEventService.recordEvent: userId and eventType are required'
        );
      }

      // ---------------------------------------------------------------------
      // 1) Validate event type
      // ---------------------------------------------------------------------

      if (!this._allowedEvents.has(eventType)) {
        logger.warn(
          'conversionEventService invalid eventType ignored',
          {
            userId,
            eventType,
          }
        );

        return { recorded: false, eventId: null };
      }

      // ---------------------------------------------------------------------
      // 2) Raw event write (SQL dedupe-safe)
      // ---------------------------------------------------------------------

      const eventId = await conversionEventRepository.recordEvent(
        userId,
        eventType,
        metadata,
        idempotencyKey
      );

      // duplicate writes become no-op in DB upsert path
      if (!eventId && idempotencyKey) {
        logger.debug(
          'conversionEventService duplicate no-op handled by DB',
          {
            userId,
            eventType,
            idempotencyKey,
          }
        );

        return { recorded: false, eventId: null };
      }

      logger.info('conversionEventService event recorded', {
        userId,
        eventType,
        eventId,
      });

      // ---------------------------------------------------------------------
      // 3) Fire-and-forget aggregate update
      // ---------------------------------------------------------------------

      this._deferAggregateUpdate(userId, eventType);

      return { recorded: true, eventId };
    } catch (error) {
      logger.error('conversionEventService.recordEvent failed', {
        userId,
        eventType,
        error: error.message,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Audit / Analytics APIs
  // ---------------------------------------------------------------------------

  async getUserEvents(userId) {
    return conversionEventRepository.getUserEvents(userId);
  }

  async getEventsByType(eventType, options) {
    return conversionEventRepository.getEventsByType(eventType, options);
  }

  async getRecentEvents(userId, limit = 50) {
    return conversionEventRepository.getRecentEvents(userId, limit);
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  _deferAggregateUpdate(userId, eventType) {
    const run = () => {
      conversionAggregateService
        .onEventRecorded(userId, eventType)
        .catch((error) => {
          logger.error(
            'conversionEventService aggregate update failed',
            {
              userId,
              eventType,
              error: error.message,
            }
          );
        });
    };

    if (typeof queueMicrotask === 'function') {
      queueMicrotask(run);
      return;
    }

    setImmediate(run);
  }
}

module.exports = new ConversionEventService();