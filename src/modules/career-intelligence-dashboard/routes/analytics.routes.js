'use strict';

/**
 * src/modules/analytics/routes/analytics.routes.js
 *
 * Mounted at:
 *   /api/v1/analytics
 *
 * Authentication:
 *   Applied globally at server.js level
 *
 * Endpoints:
 *   GET /career-demand
 *   GET /skill-demand
 *   GET /education-roi
 *   GET /career-growth
 *   GET /industry-trends
 *   GET /overview
 *   GET /snapshots/:metric
 */

const { Router } = require('express');
const analyticsController = require('../controllers/analytics.controller');

const router = Router();

/* -------------------------------------------------------------------------- */
/* Primary analytics metrics */
/* -------------------------------------------------------------------------- */

router.get('/career-demand', analyticsController.getCareerDemand);
router.get('/skill-demand', analyticsController.getSkillDemand);
router.get('/education-roi', analyticsController.getEducationROI);
router.get('/career-growth', analyticsController.getCareerGrowth);
router.get('/industry-trends', analyticsController.getIndustryTrends);

/* -------------------------------------------------------------------------- */
/* Aggregated views */
/* -------------------------------------------------------------------------- */

router.get('/overview', analyticsController.getOverview);

/* -------------------------------------------------------------------------- */
/* Historical snapshots */
/* -------------------------------------------------------------------------- */

router.get('/snapshots/:metric', analyticsController.getSnapshots);

module.exports = Object.freeze(router);