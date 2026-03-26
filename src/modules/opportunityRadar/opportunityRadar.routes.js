'use strict';

/**
 * opportunityRadar.routes.js
 *
 * Registers the AI Career Opportunity Radar endpoints.
 *
 * Mount in server.js — ONE line after existing route registrations:
 *
 *   app.use('/api/v1', authenticate,
 *     require('./modules/opportunityRadar/opportunityRadar.routes'));
 *
 * Endpoints exposed:
 *   GET  /api/v1/career/opportunity-radar          — personalised radar
 *   GET  /api/v1/career/emerging-roles             — emerging role catalogue
 *   POST /api/v1/career/opportunity-radar/refresh  — admin signal refresh
 *
 * @module src/modules/opportunityRadar/opportunityRadar.routes
 */

const { Router } = require('express');
const controller  = require('./opportunityRadar.controller');

const router = Router();

// Personalised radar for the authenticated user
router.get('/career/opportunity-radar',         controller.getOpportunityRadar);

// Public catalogue of emerging roles (still requires auth for rate limiting)
router.get('/career/emerging-roles',            controller.getEmergingRoles);

// Admin-only: trigger signal refresh from LMI data
router.post('/career/opportunity-radar/refresh', controller.refreshSignals);

module.exports = router;









