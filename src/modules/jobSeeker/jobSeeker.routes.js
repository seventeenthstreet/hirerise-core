'use strict';

/**
 * jobSeeker.routes.js — Job Seeker Intelligence API
 *
 * Mounted at: /api/v1/job-seeker
 *
 * All routes require authentication. Job-seeker-only — student path
 * users are not affected.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ GET  /skills/user-graph    │ User's personalised skill graph    │
 * │ GET  /skills/skill-gap     │ Skill gap vs market demand         │
 * │ GET  /jobs/match           │ Top 10 matched roles               │
 * │ GET  /jobs/recommendations │ Top 5 enriched recommendations     │
 * └─────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const { query } = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const { asyncHandler } = require('../../utils/helpers');
const skillGraphEngine  = require('./skillGraphEngine.service');
const jobMatchingEngine = require('./jobMatchingEngine.service');

const router = express.Router();

// ─── GET /skills/user-graph ───────────────────────────────────────────────────

/**
 * Returns the user's personalised skill graph:
 *   existing_skills, adjacent_skills, next_level_skills, role_specific_skills
 *
 * Response is cached per user for 10 minutes.
 */
router.get(
  '/skills/user-graph',
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const data   = await skillGraphEngine.getUserSkillGraph(userId);

    return res.json({
      success: true,
      data,
      cached_ttl_seconds: 600,
    });
  })
);

// ─── GET /skills/skill-gap ────────────────────────────────────────────────────

/**
 * Returns the user's skill gap analysis:
 *   existing_skills, adjacent_skills, missing_high_demand, role_gap, learning_paths
 *
 * Response is cached per user for 10 minutes.
 */
router.get(
  '/skills/skill-gap',
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const data   = await skillGraphEngine.detectSkillGap(userId);

    return res.json({
      success: true,
      data,
      cached_ttl_seconds: 600,
    });
  })
);

// ─── GET /jobs/match ──────────────────────────────────────────────────────────

/**
 * Returns the top matched roles for the user.
 *
 * Query params:
 *   limit    {number} 1-20, default 10
 *   minScore {number} 0-100, default 30
 */
router.get(
  '/jobs/match',
  validate([
    query('limit').optional().isInt({ min: 1, max: 20 }).toInt(),
    query('minScore').optional().isInt({ min: 0, max: 100 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const userId   = req.user.uid;
    const limit    = req.query.limit    || 10;
    const minScore = req.query.minScore || 30;

    const data = await jobMatchingEngine.getJobMatches(userId, { limit, minScore });

    return res.json({
      success: true,
      data,
      cached_ttl_seconds: 600,
    });
  })
);

// ─── GET /jobs/recommendations ────────────────────────────────────────────────

/**
 * Returns enriched top-5 job recommendations with a summary message.
 */
router.get(
  '/jobs/recommendations',
  asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const data   = await jobMatchingEngine.getRecommendations(userId);

    return res.json({
      success: true,
      data,
      cached_ttl_seconds: 600,
    });
  })
);

module.exports = router;








