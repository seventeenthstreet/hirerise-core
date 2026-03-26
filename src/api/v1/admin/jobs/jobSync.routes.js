'use strict';

const { Router }       = require('express');
const rateLimit        = require('express-rate-limit');
const { syncJobs }     = require('./controllers/jobSync.controller');
const { requireAdmin } = require('../../../middleware/auth.middleware');
const logger           = require('../../../../shared/logger');

const router = Router();

/**
 * IMPORTANT:
 * Ensure in main app:
 *   app.set('trust proxy', 1);
 * when running behind load balancers (Cloud Run / Nginx / etc).
 */

const syncRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,

  // Let express-rate-limit handle IP detection correctly via trust proxy.
  handler: (req, res) => {
    logger.warn('[AdminJobSyncRateLimit] limit exceeded', {
      ip: req.ip,
      path: req.originalUrl,
    });

    res.status(429).json({
      success: false,
      message:
        'Too many sync requests. Maximum 5 per 15 minutes per IP. Please try again later.',
    });
  },

  // Optional skip logic (safe for internal probes)
  skip: (req) => req.headers['x-internal-health-check'] === 'true',
});

/**
 * POST /admin/jobs/sync
 */
router.post(
  '/sync',
  syncRateLimiter,
  requireAdmin,
  syncJobs
);

/**
 * Explicitly block other methods on /sync
 */
router.all('/sync', (req, res) => {
  return res.status(405).json({
    success: false,
    message: 'Method Not Allowed',
  });
});

module.exports = router;








