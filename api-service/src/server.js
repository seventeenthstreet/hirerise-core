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

app.set('trust proxy', 1);
app.disable('x-powered-by');

// ─────────────────────────────────────────────────────────────────────────────
// BODY PARSING
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Handle invalid JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'INVALID_JSON',
      message: 'Malformed JSON payload',
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }
  next(err);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY HEADERS
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// OBSERVABILITY
// ─────────────────────────────────────────────────────────────────────────────

app.use(requestLogger);

// Global rate limit (before routes)
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
  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'Endpoint not found',
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
  });
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

// Tune timeouts (important for production)
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

const shutdown = (signal) => {
  logger.info(`Received ${signal}, shutting down`);

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit fallback
  setTimeout(() => {
    logger.error('Forced shutdown');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;