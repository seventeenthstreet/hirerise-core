import express from 'express';
import { loadConfig } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import { errorHandler } from './middleware/error.middleware.js';
import { requestLogger } from './middleware/request-logger.middleware.js';
import { resumeRouter } from './routes/resume.routes.js';
import { salaryRouter } from './routes/salary.routes.js';
import { careerRouter } from './routes/career.routes.js';
import { healthRouter } from './routes/health.routes.js';

process.env.SERVICE_NAME = 'api-service';

const config = loadConfig('api-service');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ─── Observability ────────────────────────────────────────────────────────────
app.use(requestLogger);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/v1/resume', resumeRouter);
app.use('/v1/salary', salaryRouter);
app.use('/v1/career', careerRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Endpoint not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  logger.info('API service started', { port: config.port, env: config.nodeEnv });
});

const shutdown = (signal) => {
  logger.info(`Received ${signal}, shutting down`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
