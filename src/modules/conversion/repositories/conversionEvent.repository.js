'use strict';

/**
 * conversionEvent.repository.js
 *
 * SOLE Firestore access point for raw conversion events.
 * Uses centralized Firebase config (test-safe).
 */

const { db, admin } = require('../../../config/firebase');
const logger = require('../utils/conversion.logger');
const { DEDUP_WINDOW_MS } = require('../utils/eventWeights.config');

const FieldValue = admin?.firestore?.FieldValue || {
  serverTimestamp: () => new Date()
};

const MAX_METADATA_SIZE_BYTES = 10 * 1024;

class ConversionEventRepository {
  constructor() {
    this._db = db; // ✅ Use centralized db
    this._root = 'conversion_events';
  }

  _eventsRef(userId) {
    return this._db
      .collection(this._root)
      .doc(userId)
      .collection('events');
  }

  async isDuplicate(userId, eventType, idempotencyKey) {
    if (!idempotencyKey) return false;

    const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS);

    try {
      const snap = await this._eventsRef(userId)
        .where('idempotencyKey', '==', idempotencyKey)
        .where('eventType', '==', eventType)
        .where('timestamp', '>=', windowStart)
        .limit(1)
        .get();

      return !snap.empty;
    } catch (err) {
      logger.error('ConversionEventRepository.isDuplicate failed', {
        userId,
        eventType,
        error: err.message,
      });
      return false;
    }
  }

  async recordEvent(userId, eventType, metadata = {}, idempotencyKey = null) {
    try {
      const safeMetadata = this._sanitizeMetadata(metadata);
      const ref = this._eventsRef(userId).doc();

      await ref.set({
        eventType,
        metadata: safeMetadata,
        idempotencyKey: idempotencyKey ?? null,
        timestamp: FieldValue.serverTimestamp(),
      });

      return ref.id;
    } catch (err) {
      logger.error('ConversionEventRepository.recordEvent failed', {
        userId,
        eventType,
        error: err.message,
      });
      throw err;
    }
  }

  async batchRecordEvents(userId, events) {
    if (!events?.length) return;

    const BATCH_LIMIT = 500;

    for (let i = 0; i < events.length; i += BATCH_LIMIT) {
      const chunk = events.slice(i, i + BATCH_LIMIT);
      const batch = this._db.batch();

      chunk.forEach(({ eventType, metadata = {}, idempotencyKey = null }) => {
        const ref = this._eventsRef(userId).doc();
        batch.set(ref, {
          eventType,
          metadata: this._sanitizeMetadata(metadata),
          idempotencyKey: idempotencyKey ?? null,
          timestamp: FieldValue.serverTimestamp(),
        });
      });

      await batch.commit();
    }
  }

  async getUserEvents(userId) {
    const snap = await this._eventsRef(userId)
      .orderBy('timestamp', 'desc')
      .get();

    return snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));
  }

  async getRecentEvents(userId, limit = 50) {
    const snap = await this._eventsRef(userId)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));
  }

  _sanitizeMetadata(metadata) {
    try {
      const str = JSON.stringify(metadata || {});
      const size = Buffer.byteLength(str, 'utf8');

      if (size > MAX_METADATA_SIZE_BYTES) {
        logger.warn('ConversionEventRepository: metadata truncated', {
          originalSize: size,
        });
        return { truncated: true };
      }

      return JSON.parse(str);
    } catch (err) {
      logger.warn('ConversionEventRepository: invalid metadata', {
        error: err.message,
      });
      return {};
    }
  }
}

module.exports = new ConversionEventRepository();