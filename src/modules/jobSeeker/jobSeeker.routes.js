'use strict';

/**
 * src/modules/jobSeeker/jobSeeker.routes.js
 *
 * Job Seeker Intelligence API
 * Mounted at: /api/v1/job-seeker
 *
 * Supabase-native route layer
 * - Firebase auth assumptions removed
 * - Strong query validation
 * - Stable API response contracts
 * - Better route modularity
 * - Safer null handling
 */

const express = require('express');
const { query } = require('express-validator');

const { validate } = require('../../middleware/requestValidator');
const { asyncHandler } = require('../../utils/helpers');
const skillGraphEngine = require('./skillGraphEngine.service');
const jobMatchingEngine = require('./jobMatchingEngine.service');

const router = express.Router();
const CACHE_TTL_SECONDS = 600;

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function getAuthenticatedUserId(req) {
  return req.user?.id || req.user?.uid || null;
}

// ─────────────────────────────────────────────────────────────
// GET /skills/user-graph
// ─────────────────────────────────────────────────────────────

router.get(
  '/skills/user-graph',
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);

    const data = await skillGraphEngine.getUserSkillGraph(userId);

    return res.json({
      success: true,
      data,
      cached_ttl_seconds: CACHE_TTL_SECONDS
    });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /skills/skill-gap
// ─────────────────────────────────────────────────────────────

router.get(
  '/skills/skill-gap',
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);

    const data = await skillGraphEngine.detectSkillGap(userId);

    return res.json({
      success: true,
      data,
      cached_ttl_seconds: CACHE_TTL_SECONDS
    });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /jobs/match
// ─────────────────────────────────────────────────────────────

router.get(
  '/jobs/match',
  validate([
    query('limit').optional().isInt({ min: 1, max: 20 }).toInt(),
    query('minScore').optional().isInt({ min: 0, max: 100 }).toInt()
  ]),
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);

    const limit = Number(req.query.limit) || 10;
    const minScore = Number(req.query.minScore) || 30;

    const data = await jobMatchingEngine.getJobMatches(userId, {
      limit,
      minScore
    });

    return res.json({
      success: true,
      data,
      cached_ttl_seconds: CACHE_TTL_SECONDS
    });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /jobs/recommendations
// ─────────────────────────────────────────────────────────────

router.get(
  '/jobs/recommendations',
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);

    const data = await jobMatchingEngine.getRecommendations(userId);

    return res.json({
      success: true,
      data,
      cached_ttl_seconds: CACHE_TTL_SECONDS
    });
  })
);

module.exports = router;