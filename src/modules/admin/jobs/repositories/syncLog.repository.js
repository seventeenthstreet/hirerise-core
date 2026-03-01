'use strict';

/**
 * syncLog.repository.js  (v2 — hardened & observable)
 *
 * Improvements:
 * - Stores requestId for traceability
 * - Redacts sourceUrl to origin only
 * - Stores durationMs for performance analytics
 * - Defensive payload validation
 * - Safe truncation of errors
 *
 * Recommended Firestore TTL:
 *   Enable TTL policy on `timestamp` field if logs should auto-expire.
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('../../../../shared/logger');

const MAX_STORED_ERRORS = 100;

class SyncLogRepository {
  constructor() {
    this._db  = getFirestore();
    this._col = 'syncLogs';
  }

  async create(payload) {
    try {

      const {
        sourceType,
        sourceUrl,
        totalRecords,
        successCount,
        failCount,
        initiatedBy,
        errors = [],
        requestId,
        durationMs,
      } = payload;

      // Defensive validation
      if (!Number.isFinite(totalRecords) ||
          !Number.isFinite(successCount) ||
          !Number.isFinite(failCount)) {
        throw new Error('Invalid numeric values in sync log payload');
      }

      let safeOrigin = 'invalid-url';
      try {
        safeOrigin = new URL(sourceUrl).origin;
      } catch {
        // ignore
      }

      const ref = this._db.collection(this._col).doc();

      await ref.set({
        type:         'JOB_SYNC',
        sourceType,
        sourceUrl:    safeOrigin,
        totalRecords,
        successCount,
        failCount,
        initiatedBy,
        requestId:    requestId ?? null,
        durationMs:   Number.isFinite(durationMs) ? durationMs : null,
        errors:       errors.slice(0, MAX_STORED_ERRORS),
        timestamp:    FieldValue.serverTimestamp(),
      });

      logger.info('[SyncLogRepository.create]', {
        logId: ref.id,
        totalRecords,
        successCount,
        failCount,
      });

      return ref.id;

    } catch (err) {
      logger.error('[SyncLogRepository.create] failed', {
        error: err.message,
      });
      throw err;
    }
  }
}

module.exports = new SyncLogRepository();