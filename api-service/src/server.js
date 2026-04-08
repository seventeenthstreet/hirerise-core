'use strict';

import express from 'express';
import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { errorHandler } from './middleware/error.middleware.js';
import { requestLogger } from './middleware/request-logger.middleware.js';
import { resumeRouter } from './routes/resume.routes.js';
import { salaryRouter } from './routes/salary.routes.js';
import { careerRouter } from './routes/career.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { globalRequestRateLimit } from './middleware/rate-limit.middleware.js';

process.env.SERVICE_NAME = 'api-service';

const config = loadConfig('api-service');
const app = express();

let isShuttingDown = false;

// ─────────────────────────────────────────────────────────────────────────────
// APP SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

app.set('trust proxy', 1);
app.disable('x-powered-by');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function createErrorPayload(req, error, message) {
  return {
    error,
    message,
    requestId: req?.requestId ?? null,
    timestamp: new Date().toISOString(),
  };
}

function invalidJsonHandler(err, req, res, next) {
  if (
    err instanceof SyntaxError &&
    err.status === 400 &&
    Object.prototype.hasOwnProperty.call(err, 'body')
  ) {
    return res.status(400).json(
      createErrorPayload(req, 'INVALID_JSON', 'Malformed JSON payload'),
    );
  }

  return next(err);
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  res.setHeader('Cache-Control', 'no-store');

  if (config.nodeEnv === 'production') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }

  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// BODY PARSING
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(invalidJsonHandler);

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────────────────────────────────────────

app.use(securityHeaders);

// ─────────────────────────────────────────────────────────────────────────────
// OBSERVABILITY
// ─────────────────────────────────────────────────────────────────────────────

app.use(requestLogger);
app.use(globalRequestRateLimit);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.use('/health', healthRouter);
app.use('/v1/resume', resumeRouter);
app.use('/v1/salary', salaryRouter);
app.use('/v1/career', careerRouter);

// ─────────────────────────────────────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  return res
    .status(404)
    .json(createErrorPayload(req, 'NOT_FOUND', 'Endpoint not found'));
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────────────────────────────────────────

const server = app.listen(config.port, () => {
  logger.info('API service started', {
    port: config.port,
    env: config.nodeEnv,
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on('error', (error) => {
  logger.error('HTTP server startup/runtime error', {
    error: error.message,
  });
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down`);

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown');
    process.exit(1);
  }, 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

process.once('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  shutdown('uncaughtException');
});

process.once('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
  shutdown('unhandledRejection');
});

export default app;