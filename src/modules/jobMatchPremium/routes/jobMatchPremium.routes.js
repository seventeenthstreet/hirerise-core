'use strict';

/**
 * src/modules/jobMatchPremium/routes/jobMatchPremium.routes.js
 *
 * Routes — Premium Match
 *
 * Endpoints:
 *   POST /api/v1/premium/match
 *   GET  /api/v1/premium/match/:resumeId/latest
 *
 * Auth stack:
 *   authenticate      — Supabase JWT verification (existing middleware)
 *   requirePaidPlan   — verifies subscription tier is paid (existing middleware)
 *
 * Mounted in server.js as:
 *   app.use('/api/v1/premium', authenticate, requirePaidPlan, jobMatchPremiumRouter);
 */

const express = require('express');

const router = express.Router();

const { handleRunMatch, handleGetLatest } = require('../controllers/jobMatchPremium.controller');

// POST /api/v1/premium/match
router.post('/match', handleRunMatch);

// GET /api/v1/premium/match/:resumeId/latest
router.get('/match/:resumeId/latest', handleGetLatest);

module.exports = router;
