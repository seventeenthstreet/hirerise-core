'use strict';

/**
 * @file src/sync/SyncLogger.js
 * @description
 * Production-grade sync summary logger.
 * Optimized for Supabase sync dashboards, retries, and failure analytics.
 */

const syncLogRepository = require('../repositories/syncLog.repository');

const MAX_ERRORS = 100;

class SyncLogger {
  constructor({
    logger,
    sourceType,
    sourceUrl,
    initiatedBy,
    requestId,
  } = {}) {
    if (!logger) {
      throw new Error('SyncLogger: logger is required');
    }

    if (!sourceType) {
      throw new Error('SyncLogger: sourceType is required');
    }

    this.logger = logger;
    this.sourceType = sourceType;
    this.sourceUrl = sourceUrl || 'internal://sync';
    this.initiatedBy = initiatedBy || null;
    this.requestId = requestId || null;
  }

  async logSuccess({ totalCount = 0, startTime, requestId } = {}) {
    return this.logSummary({
      successCount: totalCount,
      failCount: 0,
      startTime,
      requestId,
    });
  }

  async logFailure({
    error,
    startTime,
    totalCount = 0,
    requestId,
  } = {}) {
    const extracted = this._extractError(error);

    return this.logSummary({
      successCount: 0,
      failCount: totalCount,
      startTime,
      errors: extracted ? [extracted] : [],
      requestId,
    });
  }

  async logSummary({
    successCount = 0,
    failCount = 0,
    startTime,
    errors = [],
    requestId,
    skippedCount = 0,
  } = {}) {
    this._assertCounts({
      successCount,
      failCount,
      skippedCount,
    });

    const totalRecords =
      successCount + failCount + skippedCount;

    const durationMs = Number.isFinite(startTime)
      ? Date.now() - startTime
      : 0;

    const safeRequestId = requestId || this.requestId;

    const log = this._childLogger({
      requestId: safeRequestId,
    });

    log.info(
      {
        sourceType: this.sourceType,
        totalRecords,
        successCount,
        failCount,
        skippedCount,
        durationMs,
      },
      'Writing sync summary'
    );

    const payload = {
      sourceType: this.sourceType,
      sourceUrl: this.sourceUrl,
      totalRecords,
      successCount,
      failCount,
      skippedCount,
      initiatedBy: this.initiatedBy,
      errors: errors
        .filter(Boolean)
        .slice(0, MAX_ERRORS),
      requestId: safeRequestId,
      durationMs,
    };

    try {
      return await syncLogRepository.create(payload);
    } catch (error) {
      this.logger.error(
        {
          error,
          sourceType: this.sourceType,
          requestId: safeRequestId,
          totalRecords,
          durationMs,
        },
        'SyncLogger failed — pipeline continues'
      );

      return null;
    }
  }

  _extractError(error) {
    if (!error) return null;

    return {
      message: error.message || String(error),
      stack: error.stack || null,
      code: error.code || null,
    };
  }

  _assertCounts({
    successCount,
    failCount,
    skippedCount,
  }) {
    for (const [key, value] of Object.entries({
      successCount,
      failCount,
      skippedCount,
    })) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(
          `${key} must be a non-negative finite number`
        );
      }
    }
  }

  _childLogger(bindings) {
    return typeof this.logger.child === 'function'
      ? this.logger.child(bindings)
      : this.logger;
  }
}

module.exports = Object.freeze({
  SyncLogger,
});