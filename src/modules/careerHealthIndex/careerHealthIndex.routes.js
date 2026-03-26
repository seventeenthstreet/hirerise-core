'use strict';

/**
 * careerHealthIndex.routes.js — FIXED
 *
 * ROOT CAUSE: Frontend calls GET /api/v1/career-health (root path) but the
 * backend only registers:
 *   GET /career-health/latest
 *   GET /career-health/history
 *   GET /career-health/provisional
 *   POST /career-health/calculate
 *
 * There is NO handler for GET / — the request falls through to the 404 handler.
 * This is why dashboard shows "Failed to load breakdown", "Failed to load skill gaps",
 * "Failed to load demand data", and "Failed to load recommendations".
 *
 * FIX: Add router.get('/', getLatestChi) as the root handler.
 * The frontend's useCareerHealth() hook calls apiFetch('/career-health') which
 * resolves to GET /api/v1/career-health — this now serves the latest CHI.
 */

const { Router } = require('express');
const { calculateChi, getLatestChi, getChiHistory, getProvisionalChi } = require('./controllers/careerHealthIndex.controller');
const { requirePaidPlan }    = require('../../middleware/requirePaidPlan.middleware');
const { aiRateLimitByPlan }  = require('../../middleware/aiRateLimitByPlan.middleware');

const router = Router();

// ── FIX: Root GET handler — this is what the frontend calls ──────────────────
// useCareerHealth() calls GET /api/v1/career-health
// Previously this route did not exist → 404 → all dashboard cards fail
router.get('/', getLatestChi);

// POST /calculate triggers a live Anthropic call — must be gated.
router.post('/calculate',   aiRateLimitByPlan, calculateChi);  // requirePaidPlan removed — free users can calculate CHI
router.get('/latest',       getLatestChi);
router.get('/history',      getChiHistory);
router.get('/provisional',  getProvisionalChi);

module.exports = router;








