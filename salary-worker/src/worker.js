import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleSalaryBenchmarkRequested } from './handlers/salary-benchmark-requested.handler.js';

process.env.SERVICE_NAME = 'salary-worker';

let subscription = null;
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress', { signal });
    return;
  }

  isShuttingDown = true;

  logger.info(`${signal} received, closing subscription`);

  try {
    if (subscription) {
      await subscription.close();
    }

    logger.info('Subscription closed, exiting');
    process.exitCode = 0;
  } catch (err) {
    logger.error('Error during shutdown', {
      signal,
      message: err?.message,
      stack: err?.stack,
    });

    process.exitCode = 1;
  }
}

async function main() {
  try {
    const config = loadConfig('salary-worker');

    logger.info('Salary worker starting', {
      service: process.env.SERVICE_NAME,
      subscription: config.pubsub.salarySubscription,
      engineVersion: config.engines.salaryVersion,
    });

    subscription = createSubscriber(
      config.pubsub.salarySubscription,
      handleSalaryBenchmarkRequested,
      {
        maxMessages: 5,
        ackDeadlineSeconds: config.pubsub.ackDeadlineSeconds,
      },
    );

    logger.info('Salary worker subscriber ready', {
      subscription: config.pubsub.salarySubscription,
    });
  } catch (err) {
    logger.error('Salary worker failed to start', {
      message: err?.message,
      stack: err?.stack,
    });

    process.exit(1);
  }
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

void main();