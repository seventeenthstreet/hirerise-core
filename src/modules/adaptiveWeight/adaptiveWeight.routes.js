'use strict';

/**
 * adaptiveWeight.routes.js
 *
 * - Clean DI setup
 * - Supabase RPC compatible
 * - Production-safe routing
 */

const { Router } = require('express');

const AdaptiveWeightController = require('./adaptiveWeight.controller');
const AdaptiveWeightService = require('./adaptiveWeight.service');
const AdaptiveWeightRepository = require('./adaptiveWeight.repository');

// Optional middlewares (recommended)
const { verifyAdmin } = require('../../middleware/verifyAdmin.middleware');
// const rateLimiter = require('../../middlewares/rateLimiter.middleware');

const router = Router();

// ═══════════════════════════════════════════════════════════
// 🔗 Dependency Injection (FINAL CLEAN VERSION)
// ═══════════════════════════════════════════════════════════

const repository = new AdaptiveWeightRepository();

const service = new AdaptiveWeightService({
  adaptiveWeightRepo: repository,
});

const controller = new AdaptiveWeightController({
  adaptiveWeightService: service,
});

// ═══════════════════════════════════════════════════════════
// 📊 ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * GET /admin/adaptive-weights
 * Fetch weights for scoring
 */
router.get(
  '/',
  verifyAdmin, // 🔒 protect admin route
  controller.getWeights
);

/**
 * POST /admin/adaptive-weights/outcome
 * Record outcome → triggers learning
 */
router.post(
  '/outcome',
  verifyAdmin,
  controller.recordOutcome
);

/**
 * POST /admin/adaptive-weights/override
 * Apply manual override
 */
router.post(
  '/override',
  verifyAdmin,
  controller.applyOverride
);

/**
 * POST /admin/adaptive-weights/override/release
 * Release override
 */
router.post(
  '/override/release',
  verifyAdmin,
  controller.releaseOverride
);

module.exports = router;
