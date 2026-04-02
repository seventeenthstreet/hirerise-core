'use strict';

import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleNotificationRequested } from './handlers/notification-requested.handler.js';

process.env.SERVICE_NAME = 'notification-worker';

// ─── Bootstrap ───────────────────────────────────────

async function start() {
  try {
    const config = loadConfig('notification-worker');

    logger.info('Notification worker starting', {
      subscription: config.pubsub.notificationSubscription,
      env: process.env.NODE_ENV,
    });

    const subscription = createSubscriber(
      config.pubsub.notificationSubscription,
      handleNotificationRequested,
      {
        maxMessages: 20,
        ackDeadlineSeconds: 30,
      }
    );

    logger.info('Notification worker started successfully');

    // ─── Graceful Shutdown ───────────────────────────

    const shutdown = async (signal) => {
      logger.info(`${signal} received — shutting down`);

      try {
        await subscription.close();
        logger.info('Subscription closed successfully');
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown', err);
        process.exit(1);
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (err) {
    logger.error('Worker failed to start', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

// ─── Global Error Handlers (CRITICAL) ─────────────────

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', {
    reason,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', {
    message: err.message,
    stack: err.stack,
  });

  // Crash intentionally — safer for workers
  process.exit(1);
});

// ─── Start Worker ────────────────────────────────────

start();