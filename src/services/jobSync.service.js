'use strict';

/**
 * path: src/services/jobSync.service.js
 */

const { SyncCoordinator } = require('../sync/SyncCoordinator');
const { SyncLockManager, ConflictError } = require('../sync/SyncLockManager');
const { SyncLogger } = require('../sync/SyncLogger');
const logger = require('../../utils/logger');
const jobRepository = require('../repositories/job.repository');

const jobSyncCoordinator = new SyncCoordinator({
  logger,
  sourceType: 'jobSync',
});

async function runJobSync(context = {}) {
  const {
    requestId = `sync-${Date.now()}`,
    initiatedBy = 'cron',
  } = context;

  try {
    return await jobSyncCoordinator.runWithLockAndLogging(
      async ({ requestId: reqId }) => {
        const jobs = await jobRepository.fetchPendingJobs();

        let successCount = 0;
        let failCount = 0;

        for (const job of jobs) {
          try {
            await jobRepository.processJob(job);
            successCount++;
          } catch (err) {
            logger.warn(
              { err, jobId: job.id, reqId },
              'Job processing failed'
            );
            failCount++;
          }
        }

        return {
          successCount,
          failCount,
        };
      },
      { requestId, initiatedBy }
    );
  } catch (err) {
    if (err instanceof ConflictError) {
      logger.info(
        { requestId, err: err.meta },
        'Job sync skipped — lock conflict'
      );

      return {
        skipped: true,
        reason: 'lock_conflict',
      };
    }

    logger.error(
      { err, requestId },
      'Job sync failed unexpectedly'
    );

    throw err;
  }
}

const lockManager = new SyncLockManager({ logger });

const syncLogger = new SyncLogger({
  logger,
  sourceType: 'jobSync',
});

async function runJobSyncManual(context = {}) {
  const {
    requestId = `sync-${Date.now()}`,
    initiatedBy = 'cron',
  } = context;

  const startTime = Date.now();

  try {
    await lockManager.acquire({ requestId, initiatedBy });
  } catch (err) {
    if (err instanceof ConflictError) {
      return { skipped: true };
    }

    throw err;
  }

  let successCount = 0;
  let failCount = 0;
  const errors = [];

  try {
    const jobs = await jobRepository.fetchPendingJobs();

    for (const job of jobs) {
      try {
        await jobRepository.processJob(job);
        successCount++;
      } catch (err) {
        failCount++;
        errors.push({
          jobId: job.id,
          message: err.message,
        });
      }
    }

    await syncLogger.logSummary({
      successCount,
      failCount,
      startTime,
      errors,
      requestId,
    });

    return {
      success: failCount === 0,
      successCount,
      failCount,
    };
  } catch (err) {
    await syncLogger.logFailure({
      error: err,
      startTime,
      totalCount: failCount,
      requestId,
    });

    throw err;
  } finally {
    await lockManager.release({
      requestId,
      initiatedBy,
    });
  }
}

async function runLightweightTask(context = {}) {
  const { requestId, initiatedBy = 'cron' } = context;

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