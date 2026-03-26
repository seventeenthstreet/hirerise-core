import { initializeApp }    from 'firebase-admin/app';
import { loadConfig }       from '../../shared/config/index.js';
import { logger }           from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleSalaryBenchmarkRequested }
  from './handlers/salary-benchmark-requested.handler.js';

process.env.SERVICE_NAME = 'salary-worker';

const config = loadConfig('salary-worker');
initializeApp();

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

const shutdown = (signal) => {
  logger.info(`${signal} received, closing subscription`);
  subscription.close().then(() => {
    logger.info('Subscription closed, exiting');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
