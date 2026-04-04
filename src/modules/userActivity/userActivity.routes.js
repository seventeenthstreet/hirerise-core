'use strict';

/**
 * userActivity.routes.js
 *
 * Route group:
 *   /api/v1/user-activity
 *
 * Endpoints:
 *   GET  /summary
 *   POST /log
 *
 * All endpoints require authenticated Supabase JWT user context.
 */

const express = require('express');

const { authenticate } = require('../../middleware/auth.middleware');
const {
  getSummary,
  logUserEvent,
} = require('./userActivity.controller');

const router = express.Router();

/**
 * Route-level auth guard
 *
 * Supabase standard:
 * authenticate() should inject req.user.id
 */
router.use(authenticate);

/**
 * GET /api/v1/user-activity/summary
 * Returns streak + recent activity insights
 */
router.get('/summary', getSummary);

/**
 * POST /api/v1/user-activity/log
 * Internal event logging endpoint
 */
router.post('/log', logUserEvent);

module.exports = router;