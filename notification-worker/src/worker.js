'use strict';

import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleNotificationRequested } from './handlers/notification-requested.handler.js';

process.env.SERVICE_NAME = 'notification-worker';

let subscription = null;
let isShuttingDown = false;

// ─────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress', { signal });
    return;
  }

  isShuttingDown = true;

  logger.info('Shutdown signal received', {
    signal,
    service: process.env.SERVICE_NAME,
  });

  try {
    if (subscription?.close) {
      await subscription.close();
      logger.info('Subscription closed successfully');
    }

    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', {
      signal,
      error: err?.message,
      stack: err?.stack,
    });

    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────

async function start() {
  try {
    const config = loadConfig('notification-worker');

    logger.info('Notification worker starting', {
      service: process.env.SERVICE_NAME,
      subscription: config.pubsub.notificationSubscription,
      env: process.env.NODE_ENV,
    });

    subscription = createSubscriber(
      config.pubsub.notificationSubscription,
      handleNotificationRequested,
      {
        maxMessages: 20,
        ackDeadlineSeconds: 30,
      }
    );

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    logger.info('Notification worker started successfully', {
      service: process.env.SERVICE_NAME,
    });
  } catch (err) {
    logger.error('Worker failed to start', {
      service: process.env.SERVICE_NAME,
      error: err?.message,
      stack: err?.stack,
    });

    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// GLOBAL ERROR HANDLERS
// ─────────────────────────────────────────────────────────────

process.on('unhandledRejection', async (reason) => {
  logger.error('Unhandled rejection', {
    service: process.env.SERVICE_NAME,
    reason:
      reason instanceof Error
        ? {
            message: reason.message,
            stack: reason.stack,
          }
        : reason,
  });

  await shutdown('unhandledRejection');
});

process.on('uncaughtException', async (err) => {
  logger.error('Uncaught exception', {
    service: process.env.SERVICE_NAME,
    message: err?.message,
    stack: err?.stack,
  });

  await shutdown('uncaughtException');
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

start();