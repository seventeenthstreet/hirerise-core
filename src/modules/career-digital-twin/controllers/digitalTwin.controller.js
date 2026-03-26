'use strict';

/**
 * modules/career-digital-twin/controllers/digitalTwin.controller.js
 *
 * Express controllers for the Career Digital Twin module.
 *
 * Endpoints handled:
 *   POST /api/career/simulations          — run a new simulation
 *   GET  /api/career/simulations          — list stored simulations for the user
 *   GET  /api/career/future-paths         — shorthand: run + return paths only
 *   DELETE /api/career/simulations/cache  — bust the user's simulation cache
 *
 * All handlers are wrapped with asyncHandler() so promise rejections are
 * forwarded to Express error middleware without boilerplate try/catch.
 *
 * Auth: every route requires a valid Firebase Bearer token. req.user is
 * injected by auth.middleware before these handlers run.
 */

'use strict';

const logger  = require('../../../utils/logger');
const { asyncHandler } = require('../../../utils/helpers');

const digitalTwinService = require('../services/digitalTwin.service');

// ─── POST /api/career/simulations ─────────────────────────────────────────────

/**
 * Run a career simulation for the authenticated user.
 *
 * Body:
 * {
 *   userProfile: {
 *     role:              string   (required)
 *     skills:            string[]
 *     experience_years:  number
 *     industry:          string
 *     salary_current:    number   (INR lakhs, optional)
 *   },
 *   marketData?:        object   (optional live market enrichment)
 *   includeNarrative?:  boolean  (default false — triggers AI path summaries)
 *   forceRefresh?:      boolean  (default false — bypass Redis cache)
 * }
 *
 * Response: { success: true, data: { career_paths, meta, simulation_id, cached } }
 */
const runSimulation = asyncHandler(async (req, res) => {
  const userId         = req.user?.uid;
  const {
    userProfile,
    marketData       = {},
    includeNarrative = false,
    forceRefresh     = false,
  } = req.body;

  if (!userProfile?.role) {
    return res.status(400).json({
      success: false,
      error:   'userProfile.role is required',
    });
  }

  logger.info('[DigitalTwinController] runSimulation', {
    userId,
    role:            userProfile.role,
    includeNarrative,
    forceRefresh,
  });

  const result = await digitalTwinService.runSimulation({
    userId,
    userProfile,
    marketData,
    includeNarrative,
    forceRefresh,
  });

  res.status(200).json({
    success: true,
    data:    result,
    meta: {
      cached:       result.cached,
      path_count:   result.career_paths?.length || 0,
      requested_at: new Date().toISOString(),
    },
  });
});

// ─── GET /api/career/simulations ──────────────────────────────────────────────

/**
 * Retrieve stored simulation history for the authenticated user.
 *
 * Query params:
 *   limit   integer  1–50  (default 10)
 *
 * Response: { success: true, data: SimulationRecord[] }
 */
const getSimulations = asyncHandler(async (req, res) => {
  const userId = req.user?.uid;
  const limit  = Math.min(parseInt(req.query.limit || '10', 10), 50);

  const records = await digitalTwinService.getStoredSimulations(userId, limit);

  res.status(200).json({
    success: true,
    data:    records,
    meta: {
      count:        records.length,
      requested_at: new Date().toISOString(),
    },
  });
});

// ─── GET /api/career/future-paths ─────────────────────────────────────────────

/**
 * Convenience endpoint — accepts query params instead of a POST body.
 * Runs a fresh simulation and returns only the career_paths array.
 * Intended for lightweight UI polling and deep-link previews.
 *
 * Query params:
 *   role               string  (required)
 *   skills             comma-separated string
 *   experience_years   number
 *   industry           string
 *
 * Response: { career_paths: CareerPath[] }
 */
const getFuturePaths = asyncHandler(async (req, res) => {
  const userId = req.user?.uid;
  const {
    role,
    skills           = '',
    experience_years = '0',
    industry         = '',
  } = req.query;

  if (!role) {
    return res.status(400).json({
      success: false,
      error:   'Query param "role" is required',
    });
  }

  const userProfile = {
    role,
    skills:           skills ? skills.split(',').map(s => s.trim()).filter(Boolean) : [],
    experience_years: parseFloat(experience_years) || 0,
    industry:         industry || '',
  };

  logger.info('[DigitalTwinController] getFuturePaths (GET shorthand)', { userId, role });

  const result = await digitalTwinService.runSimulation({
    userId,
    userProfile,
    includeNarrative: false,
    forceRefresh:     false,
  });

  // Return in the exact shape specified in the project brief
  res.status(200).json({
    career_paths: (result.career_paths || []).map(p => ({
      path:              p.path,
      salary_projection: p.salary_projection,
      growth_score:      p.growth_score,
      risk_level:        p.risk_level,
      skills_required:   p.skills_required,
      next_role:         p.next_role,
      transition_months: p.transition_months,
      total_years:       p.total_years,
      strategy:          p.strategy_label,
    })),
  });
});

// ─── DELETE /api/career/simulations/cache ─────────────────────────────────────

/**
 * Bust the cache for the current user's simulation.
 * Call this after the user updates their profile or skills.
 *
 * Body: { role: string }
 *
 * Response: { success: true, message: 'Cache invalidated' }
 */
const invalidateCache = asyncHandler(async (req, res) => {
  const userId = req.user?.uid;
  const { role } = req.body;

  await digitalTwinService.invalidateUserCache(userId, role);

  res.status(200).json({
    success: true,
    message: 'Simulation cache invalidated',
  });
});

module.exports = {
  runSimulation,
  getSimulations,
  getFuturePaths,
  invalidateCache,
};









