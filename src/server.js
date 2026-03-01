/**
 * server.js — HireRise Core Engine Entry Point (HARDENED VERSION)
 *
 * Fixes:
 *  - Health route correctly under /api/v1/health
 *  - Removed global authenticate ordering bug
 *  - Auth applied per route group
 *  - Preserves 404 correctness
 *
 * Hardening additions:
 *  - requireAdmin exported from auth.middleware (fixes silent 403 bug)
 *  - Stripe raw body parsing before express.json (webhook sig verification)
 *  - Webhook routes registered before protected routes (no auth required)
 *  - Admin metrics + admin AI routes registered with requireAdmin guard
 */

'use strict';

require('dotenv').config();
require('./config/firebase');
console.log("SERVER NODE_ENV:", process.env.NODE_ENV);

const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const cors        = require('cors');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const logger = require('./utils/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { correlationMiddleware }         = require('./middleware/correlation.middleware');
const { authenticate, requireAdmin }    = require('./middleware/auth.middleware'); // ← added requireAdmin

const app = express();

// Trust proxy (Cloud Run / Load Balancer safe)
app.set('trust proxy', 1);

// Correlation ID must be first
app.use(correlationMiddleware);

app.use(helmet());
app.use(compression());

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Correlation-ID', 'Idempotency-Key'],
  exposedHeaders: ['X-Correlation-ID', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400,
}));

// ── Body Parsing ──────────────────────────────────────────────────────────────
// IMPORTANT: Stripe webhook route must receive raw Buffer for signature
// verification — must be registered BEFORE express.json() processes the body.
app.use('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' })); // ← NEW

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(
    process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
    { stream: { write: msg => logger.http(msg.trim()) } }
  ));
}

// Global Rate Limiter
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many requests from this IP. Please retry later.' },
});
app.use(globalLimiter);

// API Prefix
const API_PREFIX = `/api/${process.env.API_VERSION || 'v1'}`;

/**
 * ✅ Health Check (PUBLIC)
 * Now correctly under /api/v1/health
 */
app.get(`${API_PREFIX}/health`, (req, res) => {
  res.status(200).json({
    status:      'healthy',
    service:     'hirerise-core',
    environment: process.env.NODE_ENV || 'development',
    version:     process.env.npm_package_version || '1.0.0',
    timestamp:   new Date().toISOString(),
    uptime:      Math.floor(process.uptime()),
  });
});

/**
 * ✅ Webhook Routes (NO authenticate — signature-verified by each handler)
 * Must be registered BEFORE protected routes and BEFORE global auth middleware.
 * Razorpay + Stripe send requests from their servers, not from users.
 */
app.use(`${API_PREFIX}/webhooks`, require('./routes/webhooks.routes')); // ← NEW

/**
 * ✅ Protected Route Modules
 * Auth applied per route group (fixes 401-before-404 bug)
 */
app.use(`${API_PREFIX}/career`,        authenticate, require('./routes/career.routes'));
app.use(`${API_PREFIX}/salary`,        authenticate, require('./routes/salary.routes'));
app.use(`${API_PREFIX}/skills`,        authenticate, require('./routes/skills.routes'));
app.use(`${API_PREFIX}/jobs`,          authenticate, require('./routes/jobs.routes'));
app.use(`${API_PREFIX}/resume-growth`, authenticate, require('./routes/resumeGrowth.routes'));
app.use(`${API_PREFIX}/growth`,        authenticate, require('./routes/growth.routes'));
app.use(`${API_PREFIX}/resume-scores`, authenticate, require('./routes/resumeScore.routes'));
app.use(`${API_PREFIX}/resumes`,       authenticate, require('./modules/resume/resume.routes'));
app.use(`${API_PREFIX}/onboarding`,    authenticate, require('./modules/onboarding/onboarding.routes'));
app.use(`${API_PREFIX}/career-health`, authenticate, require('./modules/careerHealthIndex/careerHealthIndex.routes'));
app.use(`${API_PREFIX}/users`,         authenticate, require('./routes/users.routes'));
app.use(`${API_PREFIX}/analyze`,       authenticate, require('./modules/analysis/analysis.route'));
app.use(`${API_PREFIX}/roles`,         authenticate, require('./modules/roles/roles.routes'));
app.use(`${API_PREFIX}/applications`,  authenticate, require('./jobApplications/jobApplications.routes'));
app.use(`${API_PREFIX}/cover-letter`,  authenticate, require('./modules/coverLetter/coverLetter.routes'));
app.use(`${API_PREFIX}/dashboard`,     authenticate, require('./modules/dashboard/dashboard.route'));
app.use(`${API_PREFIX}/app-entry`,     authenticate, require('./modules/appEntry/appEntry.route'));
app.use(`${API_PREFIX}/qualifications`, authenticate, require('./modules/qualification/qualification.routes'));

/**
 * ✅ Admin Routes (authenticate + requireAdmin)
 * requireAdmin checks decoded.admin === true OR decoded.role === 'admin'|'super_admin'
 * Requires custom claim to be set on the Firebase user:
 *   await getAuth().setCustomUserClaims(uid, { admin: true, role: 'admin' });
 */
app.use(`${API_PREFIX}/admin/metrics`, authenticate, requireAdmin, require('./routes/admin/adminMetrics.routes'));  // ← NEW
app.use(`${API_PREFIX}/admin/ai`,      authenticate, requireAdmin, require('./routes/admin/ai-observability.routes')); // ← NEW (was unguarded)

/**
 * 404 + Error Handlers
 */
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = parseInt(process.env.PORT || '3000', 10);
let server;

if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info(`[Server] HireRise Core running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`[Server] API Base: ${API_PREFIX}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`[Server] Port ${PORT} is already in use.`);
    } else {
      logger.error('[Server] Startup error:', err);
    }
  });

  const gracefulShutdown = (signal) => {
    logger.info(`[Server] ${signal} received — shutting down gracefully...`);
    if (server) server.close(() => logger.info('[Server] HTTP server closed.'));
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('[Server] Unhandled Promise Rejection:', reason));
  process.on('uncaughtException',  (err)    => logger.error('[Server] Uncaught Exception:', err));
}

module.exports = app;