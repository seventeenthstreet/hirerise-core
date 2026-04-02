'use strict';

/**
 * adaptiveWeight.routes.js (SUPABASE OPTIMIZED)
 *
 * ✅ Firebase fully removed
 * ✅ Dependency injection fixed
 * ✅ Async-safe route handling
 * ✅ Input validation added
 * ✅ Observability ready
 */

const { Router } = require('express');

const AdaptiveWeightController  = require('./adaptiveWeight.controller');
const { AdaptiveWeightService } = require('./adaptiveWeight.service');
const AdaptiveWeightRepository  = require('./adaptiveWeight.repository');

// ✅ Use a single Supabase client export
const { supabase } = require('../../config/supabase');

// Optional (if you have logger)
let logger;
try {
  logger = require('../../shared/logger').logger;
} catch {
  logger = console;
}

// ── Async Wrapper (prevents unhandled promise crashes) ─────────────────────────
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Simple Validation Middleware ──────────────────────────────────────────────
const validateKey = (req, res, next) => {
  const { roleFamily, experienceBucket, industryTag } =
    req.method === 'GET' ? req.query : req.body;

  if (!roleFamily || !experienceBucket || !industryTag) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'roleFamily, experienceBucket, and industryTag are required',
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

// ── Dependency Injection ──────────────────────────────────────────────────────
const repo = new AdaptiveWeightRepository(supabase);
const service = new AdaptiveWeightService({ repo });
const controller = new AdaptiveWeightController({ service });

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

/**
 * GET /
 * Fetch adaptive weights
 */
router.get(
  '/',
  validateKey,
  asyncHandler(controller.getWeights.bind(controller))
);

/**
 * POST /outcome
 * Record hiring outcome
 */
router.post(
  '/outcome',
  validateKey,
  asyncHandler(controller.recordOutcome.bind(controller))
);

/**
 * POST /override
 * Apply manual override
 */
router.post(
  '/override',
  validateKey,
  asyncHandler(controller.applyOverride.bind(controller))
);

/**
 * POST /override/release
 * Release override
 */
router.post(
  '/override/release',
  validateKey,
  asyncHandler(controller.releaseOverride.bind(controller))
);

// ── Health Debug Route (optional but useful) ──────────────────────────────────
router.get('/_health', (req, res) => {
  res.json({
    success: true,
    service: 'adaptive-weight',
    db: 'supabase',
    timestamp: new Date().toISOString(),
  });
});

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = router;