import { initializeApp } from 'firebase-admin/app';
import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleNotificationRequested } from './handlers/notification-requested.handler.js';

process.env.SERVICE_NAME = 'notification-worker';

const config = loadConfig('notification-worker');
initializeApp();

logger.info('Notification worker starting', {
  subscription: config.pubsub.notificationSubscription,
});

const subscription = createSubscriber(
  config.pubsub.notificationSubscription,
  handleNotificationRequested,
  {
    maxMessages: 20,
    ackDeadlineSeconds: 30,
  }
);

const shutdown = (signal) => {
  logger.info(`${signal} received`);
  subscription.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));