'use strict';

/**
 * src/modules/career-health/careerHealthIndex.routes.js
 *
 * Production-grade routing for Career Health Index.
 *
 * Improvements:
 * - Preserves root GET compatibility for frontend hook
 * - Removes dead imports / legacy gating assumptions
 * - Standardizes route ordering for static paths before dynamic growth
 * - Keeps free-tier CHI calculation enabled with AI rate limiting
 * - Improves maintainability via controller namespace import
 */

const { Router } = require('express');
const chiController = require('./controllers/careerHealthIndex.controller');
const { aiRateLimitByPlan } = require('../../middleware/aiRateLimitByPlan.middleware');

const router = Router();

/**
 * Frontend primary endpoint
 * GET /api/v1/career-health
 */
router.get('/', chiController.getLatestChi);

/**
 * Explicit endpoints
 */
router.get('/latest', chiController.getLatestChi);
router.get('/history', chiController.getChiHistory);
router.get('/provisional', chiController.getProvisionalChi);

/**
 * Live CHI calculation
 * Free users allowed, protected by plan-aware AI rate limiter.
 */
router.post('/calculate', aiRateLimitByPlan, chiController.calculateChi);

module.exports = router;
