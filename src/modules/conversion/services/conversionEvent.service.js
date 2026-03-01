'use strict';

/**
 * conversionEvent.service.js
 *
 * Responsibilities:
 *  1. Validate eventType
 *  2. Idempotency guard
 *  3. Raw event audit write
 *  4. Fire-and-forget aggregate update
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
   * @param {object} metadata
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
    if (!userId || !eventType) {
      throw new Error(
        'conversionEventService.recordEvent: userId and eventType are required'
      );
    }

    // -----------------------------------------------------------------------
    // 1. Validate Event Type
    // -----------------------------------------------------------------------

    if (!this._allowedEvents.has(eventType)) {
      logger.warn('conversionEventService: invalid eventType ignored', {
        userId,
        eventType,
      });

      return { recorded: false, eventId: null };
    }

    // -----------------------------------------------------------------------
    // 2. Deduplication Guard
    // -----------------------------------------------------------------------

    if (idempotencyKey) {
      const duplicate =
        await conversionEventRepository.isDuplicate(
          userId,
          eventType,
          idempotencyKey
        );

      if (duplicate) {
        logger.warn('conversionEventService: duplicate dropped', {
          userId,
          eventType,
          idempotencyKey,
        });

        return { recorded: false, eventId: null };
      }
    }

    // -----------------------------------------------------------------------
    // 3. Raw Event Write (Audit Log)
    // -----------------------------------------------------------------------

    const eventId = await conversionEventRepository.recordEvent(
      userId,
      eventType,
      metadata,
      idempotencyKey
    );

    logger.info('conversionEventService: event recorded', {
      userId,
      eventType,
      eventId,
    });

    // -----------------------------------------------------------------------
    // 4. Fire-and-Forget Aggregate Update
    // -----------------------------------------------------------------------

    setImmediate(() => {
      conversionAggregateService
        .onEventRecorded(userId, eventType)
        .catch((err) =>
          logger.error(
            'conversionEventService: aggregate update failed',
            {
              userId,
              eventType,
              error: err.message,
            }
          )
        );
    });

    return { recorded: true, eventId };
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
}

module.exports = new ConversionEventService();