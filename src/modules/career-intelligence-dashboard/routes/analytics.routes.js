'use strict';

/**
 * routes/analytics.routes.js
 *
 * Mounted at: /api/v1/analytics
 * Auth applied at server.js level via authenticate middleware.
 *
 *   GET /career-demand      — Career Demand Index (ranked)
 *   GET /skill-demand       — Skill Demand Index  (ranked)
 *   GET /education-roi      — Education ROI Index (ranked)
 *   GET /career-growth      — 10-year salary forecast per career
 *   GET /industry-trends    — Emerging sector analysis
 *   GET /overview           — All five metrics in one response
 *   GET /snapshots/:metric  — Historical snapshots (?days=30)
 */

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/analytics.controller');

router.get('/career-demand',       controller.getCareerDemand);
router.get('/skill-demand',        controller.getSkillDemand);
router.get('/education-roi',       controller.getEducationROI);
router.get('/career-growth',       controller.getCareerGrowth);
router.get('/industry-trends',     controller.getIndustryTrends);
router.get('/overview',            controller.getOverview);
router.get('/snapshots/:metric',   controller.getSnapshots);

module.exports = router;









