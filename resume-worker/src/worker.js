import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleResumeSubmitted } from './handlers/resume-submitted.handler.js';

process.env.SERVICE_NAME = 'resume-worker';

const config = loadConfig('resume-worker');

// ❌ Firebase removed — no initializeApp()

logger.info('Resume worker starting', {
  subscription: config.pubsub.resumeSubscription,
  engineVersion: config.engines.resumeVersion,
});

const subscription = createSubscriber(
  config.pubsub.resumeSubscription,
  handleResumeSubmitted,
  {
    maxMessages: 5,
    ackDeadlineSeconds: config.pubsub.ackDeadlineSeconds,
  }
);

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received, closing subscription`);

  try {
    await subscription.close();
    logger.info('Subscription closed, exiting');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
    process.exit(1);
  }
};

// Signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));