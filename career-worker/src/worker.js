import { initializeApp } from 'firebase-admin/app';
import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { createSubscriber, publishEvent, EventTypes } from '../../shared/pubsub/index.js';
import { partitionedJobRepo as jobRepo } from '../../shared/repositories/partitioned-jobs.repository.js';
import { resolveEngine } from '../../shared/engine-versions/index.js';
import { CareerPathEngineV1 } from './engines/career-path-v1.engine.js';

process.env.SERVICE_NAME = 'career-worker';

const config = loadConfig('career-worker');
initializeApp();

const ENGINE_MAP = {
  'career_path_v1.0': CareerPathEngineV1,
};

const ENGINE_VERSION = config.engines.careerVersion;

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

async function handleCareerPathRequested(envelope, message) {
  const { payload } = envelope;
  const { userId, jobId, currentTitle, targetTitle, currentSkills } = payload;

  const childLogger = logger.child({
    handler: 'handleCareerPathRequested',
    userId,
    jobId,
    engineVersion: ENGINE_VERSION,
    deliveryAttempt: message.deliveryAttempt,
  });

  // 🔥 Sharded job claim
  const { claimed, status } =
    await jobRepo.claimJob(jobId, process.env.SERVICE_NAME);

  if (!claimed) {
    childLogger.info('Job already claimed or processed', { status });
    return;
  }

  childLogger.info('Processing career path');

  try {
    const engine = resolveEngine(ENGINE_VERSION, ENGINE_MAP);

    const result = engine.model({
      currentTitle,
      targetTitle,
      currentSkills,
    });

    // Persist result in sharded job
    await jobRepo.completeJob(jobId, result);

    // Emit notification
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
      milestoneCount: result.milestones?.length ?? 0,
    });

  } catch (err) {
    childLogger.error('Career path failed', { err });

    await jobRepo.failJob(
      jobId,
      err.code ?? 'CAREER_ERROR',
      err.message
    );

    throw err; // nack for retry/DLQ
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

const shutdown = (signal) => {
  logger.info(`${signal} received`);
  subscription.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 15000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));