'use strict';

/**
 * conversionAggregate.repository.js
 *
 * SOLE Firestore access for conversion aggregate documents.
 * Uses centralized Firebase config (test-safe).
 */

const { db, admin } = require('../../../config/firebase');
const logger = require('../utils/conversion.logger');
const {
  HARD_COUNTER_LIMIT,
  SCORE_VERSION,
} = require('../utils/eventWeights.config');

// Safe FieldValue fallback for test mode
const FieldValue =
  admin?.firestore?.FieldValue || {
    serverTimestamp: () => new Date(),
  };

class ConversionAggregateRepository {
  constructor() {
    this._db = db; // ✅ use centralized db
    this._collection = 'conversion_aggregates';
  }

  _ref(userId) {
    return this._db.collection(this._collection).doc(userId);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getAggregate(userId) {
    try {
      const snap = await this._ref(userId).get();
      if (!snap.exists) return null;
      return snap.data();
    } catch (err) {
      logger.error('ConversionAggregateRepository.getAggregate failed', {
        userId,
        error: err.message,
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Transactional Counter Increment
  // ---------------------------------------------------------------------------

  async incrementAndUpdate(userId, eventType, computeScoresFn) {
    const ref = this._ref(userId);

    try {
      await this._db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);

        let existingData = null;
        let eventCounts = {};

        if (snap.exists) {
          existingData = snap.data();
          eventCounts = { ...(existingData.eventCounts || {}) };
        }

        const currentCount = eventCounts[eventType] || 0;
        const newCount = Math.min(currentCount + 1, HARD_COUNTER_LIMIT);
        eventCounts[eventType] = newCount;

        const {
          engagementScore,
          monetizationScore,
          totalIntentScore,
          isEngagementEvent,
          isMonetizationEvent,
        } = computeScoresFn(existingData, eventCounts);

        const updatePayload = {
          eventCounts,
          engagementScore,
          monetizationScore,
          totalIntentScore,
          scoreVersion: SCORE_VERSION,
          lastUpdatedAt: FieldValue.serverTimestamp(),
        };

        if (isEngagementEvent) {
          updatePayload.lastEngagementEventAt =
            FieldValue.serverTimestamp();
        }

        if (isMonetizationEvent) {
          updatePayload.lastMonetizationEventAt =
            FieldValue.serverTimestamp();
        }

        updatePayload.lastEventAt = FieldValue.serverTimestamp();

        if (!snap.exists) {
          tx.set(ref, updatePayload);
        } else {
          tx.update(ref, updatePayload);
        }
      });

      logger.debug(
        'ConversionAggregateRepository.incrementAndUpdate',
        { userId, eventType }
      );
    } catch (err) {
      logger.error(
        'ConversionAggregateRepository.incrementAndUpdate failed',
        {
          userId,
          eventType,
          error: err.message,
        }
      );
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Manual Upsert
  // ---------------------------------------------------------------------------

  async upsertAggregate(userId, data) {
    try {
      await this._ref(userId).set(
        {
          ...data,
          scoreVersion: SCORE_VERSION,
          lastUpdatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      logger.error(
        'ConversionAggregateRepository.upsertAggregate failed',
        {
          userId,
          error: err.message,
        }
      );
      throw err;
    }
  }
}

module.exports = new ConversionAggregateRepository();