'use strict';

/**
 * src/modules/labor-market-intelligence/routes/market.routes.js
 *
 * Labor Market Intelligence routes.
 *
 * Mounted from:
 *   app.use(`${API_PREFIX}/market`, authenticate, marketRoutes)
 */

const { Router } = require('express');
const controller = require('../controllers/market.controller');

const router = Router();

// ───────────────────────────────────────────────────────────────────────────────
// Read APIs
// ───────────────────────────────────────────────────────────────────────────────

router.get('/career-trends', controller.getCareerTrends);
router.get('/skill-demand', controller.getSkillDemand);
router.get('/salary-benchmarks', controller.getSalaryBenchmarks);

// ───────────────────────────────────────────────────────────────────────────────
// Admin Actions
// ───────────────────────────────────────────────────────────────────────────────

router.post('/refresh', controller.runRefresh);
router.post('/ingest', controller.runIngest);

module.exports = Object.freeze(router);