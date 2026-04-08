'use strict';

/**
 * @file src/sync/SyncCoordinator.js
 * @description
 * Production-grade sync orchestration coordinator.
 * Handles:
 * - distributed locking
 * - summary/failure logging
 * - safe release semantics
 * - result validation
 * - duration tracking
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
    if (typeof asyncFn !== 'function') {
      throw new TypeError(
        'runWithLockAndLogging requires an async function'
      );
    }

    const { requestId, initiatedBy } = context;
    const startTime = Date.now();

    const log = this._childLogger({
      requestId,
      initiatedBy,
      sourceType: this.sourceType,
    });

    let result = null;
    let originalError = null;

    await this.lockManager.acquire({
      requestId,
      initiatedBy,
    });

    try {
      result = await asyncFn({
        requestId,
        initiatedBy,
        startTime,
      });

      this._assertFnResult(result);

      await this.syncLogger.logSummary({
        successCount: result.successCount,
        failCount: result.failCount,
        skippedCount: result.skippedCount || 0,
        totalCount:
          result.totalCount ??
          result.successCount + result.failCount,
        startTime,
        requestId,
      });

      return {
        success: result.failCount === 0,
        ...result,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      originalError = error;

      log.error(
        {
          error,
          requestId,
          sourceType: this.sourceType,
        },
        'Coordinated sync failed'
      );

      await this.syncLogger.logFailure({
        error,
        startTime,
        totalCount:
          result?.totalCount ??
          result?.successCount ??
          0,
        requestId,
      });

      throw error;
    } finally {
      try {
        await this.lockManager.release({
          requestId,
          initiatedBy,
        });
      } catch (releaseError) {
        log.error(
          {
            releaseError,
            requestId,
          },
          'Failed to release sync lock'
        );

        if (!originalError) {
          throw releaseError;
        }
      }
    }
  }

  _assertFnResult(result) {
    if (!result || typeof result !== 'object') {
      throw new TypeError(
        'asyncFn must return an object with successCount and failCount'
      );
    }

    const { successCount, failCount } = result;

    if (!Number.isFinite(successCount) || successCount < 0) {
      throw new TypeError(
        'successCount must be a non-negative finite number'
      );
    }

    if (!Number.isFinite(failCount) || failCount < 0) {
      throw new TypeError(
        'failCount must be a non-negative finite number'
      );
    }
  }

  _childLogger(bindings) {
    return typeof this.logger.child === 'function'
      ? this.logger.child(bindings)
      : this.logger;
  }
}

module.exports = Object.freeze({
  SyncCoordinator,
});