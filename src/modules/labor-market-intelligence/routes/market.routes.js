'use strict';

/**
 * routes/market.routes.js
 *
 * Mount in server.js:
 *   app.use(`${API_PREFIX}/market`, authenticate,
 *     require('./modules/labor-market-intelligence/routes/market.routes'));
 *
 * Endpoints:
 *   GET  /api/v1/market/career-trends
 *   GET  /api/v1/market/skill-demand
 *   GET  /api/v1/market/salary-benchmarks
 *   POST /api/v1/market/refresh   (admin)
 *   POST /api/v1/market/ingest    (admin)
 */

const { Router } = require('express');
const controller = require('../controllers/market.controller');

const router = Router();

router.get('/career-trends',      controller.getCareerTrends);
router.get('/skill-demand',       controller.getSkillDemand);
router.get('/salary-benchmarks',  controller.getSalaryBenchmarks);
router.post('/refresh',           controller.runRefresh);
router.post('/ingest',            controller.runIngest);

module.exports = router;









