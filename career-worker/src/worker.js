'use strict';

/**
 * career-worker/src/worker.js — production hardened
 */

process.env.SERVICE_NAME = 'career-worker';

const { loadConfig } = require('../../shared/config/index.js');
const { logger } = require('../../shared/logger/index.js');
const { sendAlert, SEVERITY } = require('../../shared/monitoring/alerts.js');
const {
  createSubscriber,
  publishEvent,
  EventTypes,
} = require('../../shared/pubsub/index.js');

const {
  partitionedJobRepo: jobRepo,
} = require('../../shared/repositories/partitioned-jobs.repository.js');

const { resolveEngine } = require('../../shared/engine-versions/index.js');
const {
  CareerPathEngineV1,
} = require('./engines/career-path-v1.engine.js');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Engine timeout')), ms)
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────
// PROCESS-LEVEL ERROR HANDLING
// ─────────────────────────────────────────────────────────────

process.once('uncaughtException', async (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  await sendAlert({
    message: 'career-worker: Uncaught exception — process will exit',
    severity: SEVERITY.CRITICAL,
    error,
    alertKey: 'career-worker:uncaughtException',
    context: { pid: process.pid },
  }).catch(() => {});
  shutdown('uncaughtException');
});

process.once('unhandledRejection', async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled rejection', { error: error.message, stack: error.stack });
  await sendAlert({
    message: 'career-worker: Unhandled rejection — process will exit',
    severity: SEVERITY.CRITICAL,
    error,
    alertKey: 'career-worker:unhandledRejection',
    context: { pid: process.pid },
  }).catch(() => {});
  shutdown('unhandledRejection');
});

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const config = loadConfig('career-worker');

if (!config?.pubsub?.careerSubscription) {
  throw new Error('Missing config.pubsub.careerSubscription');
}

const ENGINE_MAP = Object.freeze({
  'career_path_v1.0': CareerPathEngineV1,
  'career_path_v1.1': CareerPathEngineV1,
});

const ENGINE_VERSION =
  config?.engines?.careerVersion || 'career_path_v1.1';

const EngineClass = resolveEngine(ENGINE_VERSION, ENGINE_MAP);

if (!EngineClass) {
  throw new Error(`Unknown engine version: ${ENGINE_VERSION}`);
}

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

async function handleCareerPathRequested(envelope = {}, message = {}) {
  const payload = envelope.payload || {};

  const {
    userId,
    jobId,
    currentTitle,
    targetTitle,
    currentSkills = [],
  } = payload;

  const childLogger = logger.child({
    service: process.env.SERVICE_NAME,
    handler: 'handleCareerPathRequested',
    userId,
    jobId,
    engineVersion: ENGINE_VERSION,
    deliveryAttempt: message.deliveryAttempt,
  });

  // Strong validation
  if (
    !jobId ||
    !userId ||
    typeof currentTitle !== 'string' ||
    typeof targetTitle !== 'string' ||
    !currentTitle.trim() ||
    !targetTitle.trim()
  ) {
    childLogger.error('Invalid payload', {
      hasJobId: Boolean(jobId),
      hasUserId: Boolean(userId),
      hasCurrentTitle: Boolean(currentTitle),
      hasTargetTitle: Boolean(targetTitle),
    });
    return;
  }

  // Optional retry guard
  if (message.deliveryAttempt > 5) {
    childLogger.error('Max delivery attempts exceeded');
    return;
  }

  let claimed = false;

  try {
    const claimResult = await jobRepo.claimJob(jobId, process.env.SERVICE_NAME);
    claimed = Boolean(claimResult?.claimed);

    if (!claimed) {
      childLogger.info('Job already claimed or processed', {
        status: claimResult?.status || 'unknown',
      });
      return;
    }

    childLogger.info('Processing career path');

    const engine = new EngineClass();

    // Async-safe + timeout protected execution
    const result = await withTimeout(
      Promise.resolve(
        engine.model({
          currentTitle,
          targetTitle,
          currentSkills: Array.isArray(currentSkills) ? currentSkills : [],
        })
      ),
      config?.engines?.timeoutMs || 15000
    );

    // Strict result validation
    if (
      !result ||
      !Array.isArray(result.milestones) ||
      !Array.isArray(result.skillGaps)
    ) {
      throw new Error('Invalid engine result structure');
    }

    await jobRepo.completeJob(jobId, result);

    const notificationTopic =
      process.env.PUBSUB_NOTIFICATION_TOPIC ||
      config?.pubsub?.notificationTopic;

    if (!notificationTopic) {
      throw new Error('Missing notification topic configuration');
    }

    // Safe publish (non-blocking for job success)
    try {
      await publishEvent(
        notificationTopic,
        EventTypes.NOTIFICATION_REQUESTED,
        {
          userId,
          notificationType: 'CAREER_PATH_READY',
          data: { jobId, engineVersion: result.engineVersion },
        },
        { userId, jobId, sourceService: process.env.SERVICE_NAME }
      );
    } catch (pubErr) {
      childLogger.error('Notification publish failed', {
        error: pubErr.message,
      });
    }

    childLogger.info('Career path completed', {
      milestoneCount: result.milestones.length,
      skillGapCount: result.skillGaps.length,
    });
  } catch (err) {
    childLogger.error('Career path failed', {
      error: err.message,
      code: err.code,
      stack: err.stack,
    });

    await sendAlert({
      message: 'career-worker: Job processing failed',
      severity: SEVERITY.HIGH,
      error: err,
      alertKey: `career-worker:job-failed:${jobId}`,
      context: { userId, jobId, engineVersion: ENGINE_VERSION },
    }).catch(() => {});

    if (claimed && jobId) {
      try {
        await jobRepo.failJob(jobId, err.code || 'CAREER_ERROR', err.message);
      } catch (failErr) {
        childLogger.error('Failed to persist failed job state', {
          error: failErr.message,
        });
      }
    }

    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Subscriber Bootstrap
// ─────────────────────────────────────────────────────────────

const subscription = createSubscriber(
  config.pubsub.careerSubscription,
  handleCareerPathRequested,
  {
    maxMessages: 3,
    ackDeadlineSeconds: config.pubsub.ackDeadlineSeconds,
  }
);

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    logger.info(`${signal} received — shutting down`);
    if (subscription?.close) await subscription.close();
    logger.info('Career worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Shutdown error', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { handleCareerPathRequested };