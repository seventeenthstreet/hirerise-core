'use strict';

/**
 * adminJobSync.routes.js (SUPABASE READY)
 *
 * ✅ Async-safe
 * ✅ Logger safe import
 * ✅ Structured error responses
 * ✅ Admin audit logging
 * ✅ Rate limit hardened
 */

const { Router } = require('express');
const rateLimit  = require('express-rate-limit');

const { syncJobs }     = require('./controllers/jobSync.controller');
const { requireAdmin } = require('../../../middleware/auth.middleware');

// ✅ Safe logger import
let logger;
try {
  logger = require('../../../../shared/logger').logger;
} catch {
  logger = console;
}

const router = Router();

/**
 * IMPORTANT:
 * Ensure in main app:
 *   app.set('trust proxy', 1);
 */

// ── Async Wrapper ─────────────────────────────────────────────────────────────
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Rate Limiter ─────────────────────────────────────────────────────────────
const syncRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,

  handler: (req, res) => {
    logger.warn('[AdminJobSyncRateLimit] limit exceeded', {
      ip: req.ip,
      path: req.originalUrl,
      adminId: req.user?.id || 'unknown',
    });

    return res.status(429).json({
      success: false,
      errorCode: 'RATE_LIMIT_EXCEEDED',
      message:
        'Too many sync requests. Maximum 5 per 15 minutes per IP.',
      timestamp: new Date().toISOString(),
    });
  },

  skip: (req) => req.headers['x-internal-health-check'] === 'true',
});

// ── Validation Middleware ─────────────────────────────────────────────────────
const validateSyncRequest = (req, res, next) => {
  // Adjust based on your syncJobs requirements
  const { source, force } = req.body || {};

  if (source && typeof source !== 'string') {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'source must be a string',
      timestamp: new Date().toISOString(),
    });
  }

  if (force !== undefined && typeof force !== 'boolean') {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'force must be a boolean',
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /admin/jobs/sync
 */
router.post(
  '/sync',
  syncRateLimiter,
  requireAdmin,
  validateSyncRequest,
  asyncHandler(async (req, res, next) => {
    logger.info('[AdminJobSync] triggered', {
      adminId: req.user?.id,
      body: req.body,
      ip: req.ip,
    });

    await syncJobs(req, res, next);
  })
);

/**
 * Block other methods on /sync
 */
router.all('/sync', (req, res) => {
  return res.status(405).json({
    success: false,
    errorCode: 'METHOD_NOT_ALLOWED',
    message: 'Method Not Allowed',
    timestamp: new Date().toISOString(),
  });
});

// ── Health Check (optional) ───────────────────────────────────────────────────
router.get('/_health', (req, res) => {
  res.json({
    success: true,
    service: 'admin-job-sync',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;