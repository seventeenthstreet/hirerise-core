import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { sendAlert, SEVERITY } from '../../shared/monitoring/alerts.js';
import { createSubscriber } from '../../shared/pubsub/index.js';
import { handleResumeSubmitted } from './handlers/resume-submitted.handler.js';

process.env.SERVICE_NAME = 'resume-worker';

let subscription = null;
let isShuttingDown = false;

// ─────────────────────────────────────────────────────────────
// PROCESS-LEVEL ERROR HANDLING
// ─────────────────────────────────────────────────────────────

process.once('unhandledRejection', async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled promise rejection', { error: error.message, stack: error.stack });
  await sendAlert({
    message: 'resume-worker: Unhandled rejection — process will exit',
    severity: SEVERITY.CRITICAL,
    error,
    alertKey: 'resume-worker:unhandledRejection',
    context: { pid: process.pid },
  }).catch(() => {});
  shutdown('unhandledRejection');
});

process.once('uncaughtException', async (err) => {
  logger.error('Uncaught exception', { error: err?.message, stack: err?.stack });
  await sendAlert({
    message: 'resume-worker: Uncaught exception — process will exit',
    severity: SEVERITY.CRITICAL,
    error: err,
    alertKey: 'resume-worker:uncaughtException',
    context: { pid: process.pid },
  }).catch(() => {});
  shutdown('uncaughtException');
});

// ─────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────

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
        ackDeadlineSeconds: config.pubsub.ackDeadlineSeconds,
      }
    );

    logger.info('Resume worker started successfully');
  } catch (err) {
    logger.error('Worker bootstrap failed', {
      service: process.env.SERVICE_NAME,
      error: err?.message ?? 'Unknown bootstrap error',
      stack: err?.stack,
    });

    await sendAlert({
      message: 'resume-worker: Bootstrap failed — worker did not start',
      severity: SEVERITY.CRITICAL,
      error: err,
      alertKey: 'resume-worker:bootstrap-failed',
      context: { pid: process.pid },
    }).catch(() => {});

    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`${signal} received, shutting down worker`);

  try {
    if (subscription?.close) await subscription.close();
    logger.info('Worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err?.message ?? 'Unknown shutdown error' });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await bootstrap();