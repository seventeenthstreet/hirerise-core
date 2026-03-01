import { initializeApp } from 'firebase-admin/app';
import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleResumeSubmitted } from './handlers/resume-submitted.handler.js';

process.env.SERVICE_NAME = 'resume-worker';

const config = loadConfig('resume-worker');
initializeApp();

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

const shutdown = (signal) => {
  logger.info(`${signal} received, closing subscription`);
  subscription.close().then(() => {
    logger.info('Subscription closed, exiting');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
