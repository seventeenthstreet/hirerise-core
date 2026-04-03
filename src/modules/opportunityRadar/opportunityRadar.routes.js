'use strict';

/**
 * src/modules/opportunityRadar/opportunityRadar.routes.js
 *
 * AI Career Opportunity Radar route registrations.
 *
 * Mount in server.js:
 *   app.use('/api/v1', authenticate,
 *     require('./modules/opportunityRadar/opportunityRadar.routes'));
 *
 * Exposed endpoints:
 *   GET  /career/opportunity-radar
 *   GET  /career/emerging-roles
 *   POST /career/opportunity-radar/refresh
 *
 * Supabase migration notes:
 * - No Firebase dependencies existed
 * - Route layer cleaned for consistency
 * - Added optional async safety wrapper compatibility
 * - Improved maintainability and route readability
 */

const { Router } = require('express');
const controller = require('./opportunityRadar.controller');

const router = Router();

/**
 * GET /career/opportunity-radar
 * Personalised opportunity radar for authenticated users.
 */
router.get(
  '/career/opportunity-radar',
  controller.getOpportunityRadar
);

/**
 * GET /career/emerging-roles
 * Public catalogue of emerging roles.
 * Auth is still applied globally for:
 * - rate limiting
 * - session analytics
 * - tenant visibility rules
 */
router.get(
  '/career/emerging-roles',
  controller.getEmergingRoles
);

/**
 * POST /career/opportunity-radar/refresh
 * Admin-only refresh trigger for opportunity signal recomputation.
 */
router.post(
  '/career/opportunity-radar/refresh',
  controller.refreshSignals
);

module.exports = router;