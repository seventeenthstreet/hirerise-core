import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleResumeSubmitted } from './handlers/resume-submitted.handler.js';

process.env.SERVICE_NAME = 'resume-worker';

let subscription = null;
let isShuttingDown = false;

async function bootstrap() {
  try {
    const config = loadConfig('resume-worker');

    logger.info('Resume worker starting', {
      service: process.env.SERVICE_NAME,
      subscription: config.pubsub.resumeSubscription,
      engineVersion: config.engines.resumeVersion,
      ackDeadlineSeconds: config.pubsub.ackDeadlineSeconds,
    });

    subscription = createSubscriber(
      config.pubsub.resumeSubscription,
      handleResumeSubmitted,
      {
        maxMessages: 5,
        ackDeadlineSeconds:
          config.pubsub.ackDeadlineSeconds,
      }
    );

    logger.info('Resume worker started successfully');
  } catch (err) {
    logger.error('Worker bootstrap failed', {
      service: process.env.SERVICE_NAME,
      error: err?.message ?? 'Unknown bootstrap error',
      stack: err?.stack,
    });

    process.exit(1);
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`${signal} received, shutting down worker`);

  try {
    if (subscription?.close) {
      await subscription.close();
    }

    logger.info('Worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', {
      error: err?.message ?? 'Unknown shutdown error',
    });

    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error:
      reason instanceof Error
        ? reason.message
        : String(reason),
  });

  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    error: err?.message ?? 'Unknown exception',
    stack: err?.stack,
  });

  shutdown('uncaughtException');
});

await bootstrap();