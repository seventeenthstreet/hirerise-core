'use strict';

/**
 * path: src/sync/SyncCoordinator.js
 */

const { SyncLockManager } = require('./SyncLockManager');
const { SyncLogger } = require('./SyncLogger');

class SyncCoordinator {
  constructor({
    logger,
    sourceType,
    sourceUrl,
    initiatedBy,
  } = {}) {
    if (!logger) {
      throw new Error('SyncCoordinator: logger is required');
    }

    if (!sourceType) {
      throw new Error('SyncCoordinator: sourceType is required');
    }

    this.logger = logger;
    this.sourceType = sourceType;

    this.lockManager = new SyncLockManager({ logger });

    this.syncLogger = new SyncLogger({
      logger,
      sourceType,
      sourceUrl,
      initiatedBy,
    });
  }

  async runWithLockAndLogging(asyncFn, context = {}) {
    const { requestId, initiatedBy } = context;
    const startTime = Date.now();

    const log = this._childLogger({
      requestId,
      initiatedBy,
      sourceType: this.sourceType,
    });

    await this.lockManager.acquire({
      requestId,
      initiatedBy,
    });

    try {
      const result = await asyncFn({
        requestId,
        initiatedBy,
        startTime,
      });

      this._assertFnResult(result);

      await this.syncLogger.logSummary({
        successCount: result.successCount,
        failCount: result.failCount,
        startTime,
        requestId,
      });

      return {
        success: result.failCount === 0,
        ...result,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      log.error({ err }, 'Coordinated sync failed');

      await this.syncLogger.logFailure({
        error: err,
        startTime,
        totalCount: 0,
        requestId,
      });

      throw err;
    } finally {
      await this.lockManager.release({
        requestId,
        initiatedBy,
      });
    }
  }

  _assertFnResult(result) {
    if (!result || typeof result !== 'object') {
      throw new TypeError(
        'asyncFn must return { successCount, failCount }'
      );
    }

    if (typeof result.successCount !== 'number') {
      throw new TypeError('Missing successCount');
    }

    if (typeof result.failCount !== 'number') {
      throw new TypeError('Missing failCount');
    }
  }

  _childLogger(bindings) {
    return this.logger.child
      ? this.logger.child(bindings)
      : this.logger;
  }
}

module.exports = { SyncCoordinator };