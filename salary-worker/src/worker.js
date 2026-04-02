import { loadConfig }       from '../../shared/config/index.js';
import { logger }           from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleSalaryBenchmarkRequested }
  from './handlers/salary-benchmark-requested.handler.js';

process.env.SERVICE_NAME = 'salary-worker';

const config = loadConfig('salary-worker');

// ❌ Firebase removed — no initializeApp()

logger.info('Salary worker starting', {
  subscription:  config.pubsub.salarySubscription,
  engineVersion: config.engines.salaryVersion,
});

const subscription = createSubscriber(
  config.pubsub.salarySubscription,
  handleSalaryBenchmarkRequested,
  {
    maxMessages:        5,
    ackDeadlineSeconds: config.pubsub.ackDeadlineSeconds,
  },
);

// Graceful shutdown (improved)
const shutdown = async (signal) => {
  logger.info(`${signal} received, closing subscription`);

  try {
    await subscription.close();
    logger.info('Subscription closed, exiting');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', {
      message: err?.message,
      stack: err?.stack,
    });
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));