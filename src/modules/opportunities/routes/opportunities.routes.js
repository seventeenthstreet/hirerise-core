'use strict';

/**
 * src/modules/opportunities/routes/opportunities.routes.js
 *
 * Mount in server.js:
 *
 *   app.use(
 *     `${API_PREFIX}/opportunities`,
 *     authenticate,
 *     require('./modules/opportunities/routes/opportunities.routes')
 *   );
 *
 * Endpoint:
 *   GET /api/v1/opportunities/:studentId
 *
 * Notes:
 * - Fully Firebase-free
 * - Supabase-compatible route layer
 * - Param validation moved to route boundary
 * - Production-safe immutable exports
 */

const express = require('express');
const controller = require('../controllers/opportunities.controller');

const router = express.Router();

/**
 * Student opportunities
 *
 * Route param is constrained to avoid malformed requests
 * reaching the controller/service layer.
 *
 * Accepts:
 * - UUID
 * - auth uid style strings
 * - alphanumeric ids with dashes/underscores
 */
router.get(
  '/:studentId([A-Za-z0-9_-]+)',
  controller.getOpportunities
);

module.exports = Object.freeze(router);