'use strict';

/**
 * Career Worker — Firebase-free, Supabase-compatible
 */

const { loadConfig } = require('../../shared/config/index.js');
const { logger } = require('../../shared/logger/index.js');
const {
  createSubscriber,
  publishEvent,
  EventTypes,
} = require('../../shared/pubsub/index.js');

const {
  partitionedJobRepo: jobRepo,
} = require('../../shared/repositories/partitioned-jobs.repository.js');

const { resolveEngine } = require('../../shared/engine-versions/index.js');
const { CareerPathEngineV1 } = require('./engines/career-path-v1.engine.js');

process.env.SERVICE_NAME = 'career-worker';

const config = loadConfig('career-worker');

const ENGINE_MAP = {
  'career_path_v1.0': CareerPathEngineV1,
};

const ENGINE_VERSION = config?.engines?.careerVersion;

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

async function handleCareerPathRequested(envelope, message) {
  const payload = envelope?.payload || {};

  const {
    userId,
    jobId,
    currentTitle,
    targetTitle,
    currentSkills = [],
  } = payload;

  const childLogger = logger.child({
    handler: 'handleCareerPathRequested',
    userId,
    jobId,
    engineVersion: ENGINE_VERSION,
    deliveryAttempt: message?.deliveryAttempt,
  });

  // ✅ Validate payload early
  if (!jobId || !userId || !currentTitle || !targetTitle) {
    childLogger.error('Invalid payload', { payload });
    return;
  }

  // 🔥 Sharded job claim
  const { claimed, status } =
    await jobRepo.claimJob(jobId, process.env.SERVICE_NAME);

  if (!claimed) {
    childLogger.info('Job already claimed or processed', { status });
    return;
  }

  childLogger.info('Processing career path');

  try {
    // ✅ FIX: instantiate engine
    const EngineClass = resolveEngine(ENGINE_VERSION, ENGINE_MAP);

    if (!EngineClass) {
      throw new Error(`Unknown engine version: ${ENGINE_VERSION}`);
    }

    const engine = new EngineClass();

    const result = engine.model({
      currentTitle,
      targetTitle,
      currentSkills,
    });

    // ✅ Persist result
    await jobRepo.completeJob(jobId, result);

    // ✅ Validate topic
    if (!process.env.PUBSUB_NOTIFICATION_TOPIC) {
      throw new Error('Missing PUBSUB_NOTIFICATION_TOPIC');
    }

    // ✅ Emit notification
    await publishEvent(
      process.env.PUBSUB_NOTIFICATION_TOPIC,
      EventTypes.NOTIFICATION_REQUESTED,
      {
        userId,
        notificationType: 'CAREER_PATH_READY',
        data: { jobId },
      },
      { userId, jobId }
    );

    childLogger.info('Career path complete', {
      milestoneCount: result?.milestones?.length || 0,
    });

  } catch (err) {
    childLogger.error('Career path failed', {
      message: err.message,
      stack: err.stack,
    });

    await jobRepo.failJob(
      jobId,
      err.code || 'CAREER_ERROR',
      err.message
    );

    throw err; // 🔥 required for retry/DLQ
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

// ✅ Safer shutdown
async function shutdown(signal) {
  try {
    logger.info(`${signal} received`);

    await subscription.close();

    process.exit(0);
  } catch (err) {
    logger.error('Shutdown error', { err });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));