'use strict';

/**
 * @file src/services/jobSync.service.js
 * @description
 * Production-grade job sync orchestration service.
 *
 * Improvements:
 * - unified lock + logging flow
 * - duplicate orchestration removed
 * - consistent failure accounting
 * - safe lock release semantics
 * - modular batch processor
 * - repository-friendly for Supabase RPC upgrades
 */

const { SyncCoordinator } = require('../sync/SyncCoordinator');
const { SyncLockManager, ConflictError } = require('../sync/SyncLockManager');
const { SyncLogger } = require('../sync/SyncLogger');
const logger = require('../utils/logger');
const jobRepository = require('../repositories/job.repository');

const SOURCE_TYPE = 'jobSync';

const jobSyncCoordinator = new SyncCoordinator({
  logger,
  sourceType: SOURCE_TYPE,
});

const lockManager = new SyncLockManager({ logger });

const syncLogger = new SyncLogger({
  logger,
  sourceType: SOURCE_TYPE,
});

function buildRequestContext(context = {}) {
  return {
    requestId: context.requestId || `sync-${Date.now()}`,
    initiatedBy: context.initiatedBy || 'cron',
  };
}

async function processPendingJobs(requestId) {
  const jobs = await jobRepository.fetchPendingJobs();

  let successCount = 0;
  let failCount = 0;
  const errors = [];

  for (const job of jobs) {
    try {
      await jobRepository.processJob(job);
      successCount++;
    } catch (error) {
      failCount++;
      errors.push({
        jobId: job?.id || null,
        message: error.message,
      });

      logger.warn(
        {
          requestId,
          jobId: job?.id,
          error: error.message,
        },
        'Job processing failed'
      );
    }
  }

  return {
    totalCount: jobs.length,
    successCount,
    failCount,
    errors,
  };
}

async function runJobSync(context = {}) {
  const { requestId, initiatedBy } = buildRequestContext(context);

  try {
    return await jobSyncCoordinator.runWithLockAndLogging(
      async ({ requestId: reqId }) => {
        const result = await processPendingJobs(reqId);

        return {
          success: result.failCount === 0,
          successCount: result.successCount,
          failCount: result.failCount,
          totalCount: result.totalCount,
        };
      },
      { requestId, initiatedBy }
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      logger.info(
        { requestId, conflict: error.meta },
        'Job sync skipped due to active lock'
      );

      return {
        skipped: true,
        reason: 'lock_conflict',
      };
    }

    logger.error(
      {
        requestId,
        error: error.message,
      },
      'Job sync failed unexpectedly'
    );

    throw error;
  }
}

async function runJobSyncManual(context = {}) {
  const { requestId, initiatedBy } = buildRequestContext(context);
  const startTime = Date.now();

  try {
    await lockManager.acquire({ requestId, initiatedBy });
  } catch (error) {
    if (error instanceof ConflictError) {
      logger.info(
        { requestId },
        'Manual job sync skipped due to active lock'
      );

      return {
        skipped: true,
        reason: 'lock_conflict',
      };
    }

    throw error;
  }

  try {
    const result = await processPendingJobs(requestId);

    await syncLogger.logSummary({
      successCount: result.successCount,
      failCount: result.failCount,
      startTime,
      errors: result.errors,
      requestId,
    });

    return {
      success: result.failCount === 0,
      successCount: result.successCount,
      failCount: result.failCount,
      totalCount: result.totalCount,
    };
  } catch (error) {
    await syncLogger.logFailure({
      error,
      startTime,
      totalCount: 0,
      requestId,
    });

    throw error;
  } finally {
    try {
      await lockManager.release({
        requestId,
        initiatedBy,
      });
    } catch (releaseError) {
      logger.error(
        {
          requestId,
          error: releaseError.message,
        },
        'Failed to release sync lock'
      );
    }
  }
}

async function runLightweightTask(context = {}) {
  const { requestId, initiatedBy } = buildRequestContext(context);

  return lockManager.runWithLock(
    async () => {
      await jobRepository.cleanupExpiredJobs();
      return { done: true };
    },
    { requestId, initiatedBy }
  );
}

module.exports = {
  runJobSync,
  runJobSyncManual,
  runLightweightTask,
};