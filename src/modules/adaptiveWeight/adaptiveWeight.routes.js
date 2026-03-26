'use strict';

const { Router }               = require('express');
const { db } = require('../../config/supabase');
const AdaptiveWeightController = require('./adaptiveWeight.controller');
const { AdaptiveWeightService } = require('./adaptiveWeight.service');
const AdaptiveWeightRepository = require('./adaptiveWeight.repository');

const router = Router();

// Wire up DI chain: repo (with db) → service → controller
const controller = new AdaptiveWeightController({
  adaptiveWeightService: new AdaptiveWeightService({
    adaptiveWeightRepo: new AdaptiveWeightRepository(db),
  }),
});

/**
 * GET /admin/adaptive-weights
 * Fetch current weights for a given roleFamily / experienceBucket / industryTag
 */
router.get('/', controller.getWeights);

/**
 * POST /admin/adaptive-weights/outcome
 * Record a scored outcome to update weights via reinforcement
 */
router.post('/outcome', controller.recordOutcome);

/**
 * POST /admin/adaptive-weights/override
 * Apply a manual weight override (admin use only)
 */
router.post('/override', controller.applyOverride);

/**
 * POST /admin/adaptive-weights/override/release
 * Release a manual override and restore adaptive weights
 */
router.post('/override/release', controller.releaseOverride);

module.exports = router;









