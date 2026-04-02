'use strict';

/**
 * path: src/sync/SyncLogger.js
 */

const syncLogRepository = require('../repositories/syncLog.repository');

const MAX_ERRORS = 100;

class SyncLogger {
  constructor({ logger, sourceType, sourceUrl, initiatedBy, requestId } = {}) {
    if (!logger) throw new Error('SyncLogger: logger is required');
    if (!sourceType) throw new Error('SyncLogger: sourceType is required');

    this.logger = logger;
    this.sourceType = sourceType;
    this.sourceUrl = sourceUrl || 'internal://sync';
    this.initiatedBy = initiatedBy || null;
    this.requestId = requestId || null;
  }

  async logSuccess({ totalCount, startTime, requestId } = {}) {
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
    return this.logSummary({
      successCount: 0,
      failCount: totalCount,
      startTime,
      errors: [this._extractError(error)],
      requestId,
    });
  }

  async logSummary({
    successCount,
    failCount,
    startTime,
    errors = [],
    requestId,
  } = {}) {
    const totalRecords = successCount + failCount;
    const durationMs = Date.now() - startTime;

    const log = this._childLogger({
      requestId: requestId || this.requestId,
    });

    log.info(
      {
        sourceType: this.sourceType,
        totalRecords,
        successCount,
        failCount,
        durationMs,
      },
      'Writing sync summary'
    );

    try {
      return await syncLogRepository.create({
        sourceType: this.sourceType,
        sourceUrl: this.sourceUrl,
        totalRecords,
        successCount,
        failCount,
        initiatedBy: this.initiatedBy,
        errors: errors.slice(0, MAX_ERRORS),
        requestId: requestId || this.requestId,
        durationMs,
      });
    } catch (err) {
      this.logger.error(
        { err },
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
    };
  }

  _childLogger(bindings) {
    return this.logger.child
      ? this.logger.child(bindings)
      : this.logger;
  }
}

module.exports = { SyncLogger };