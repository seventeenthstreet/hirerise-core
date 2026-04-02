'use strict';

/**
 * modules/career-digital-twin/controllers/digitalTwin.controller.js
 *
 * Express controllers for the Career Digital Twin module.
 *
 * Endpoints handled:
 *   POST   /api/career/simulations          — run a new simulation
 *   GET    /api/career/simulations          — list stored simulations
 *   GET    /api/career/future-paths         — shorthand: run + return paths only
 *   DELETE /api/career/simulations/cache    — bust simulation cache
 *
 * Auth:
 *   Every route requires a valid authenticated JWT.
 *   req.user is injected by auth.middleware before these handlers run.
 */

const logger = require('../../../utils/logger');
const { asyncHandler } = require('../../../utils/helpers');
const digitalTwinService = require('../services/digitalTwin.service');

const MAX_SIMULATION_HISTORY_LIMIT = 50;
const DEFAULT_SIMULATION_HISTORY_LIMIT = 10;

/**
 * Safely normalize a limit query param.
 * Prevents NaN, negative values, and excessive reads.
 */
function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SIMULATION_HISTORY_LIMIT;
  }

  return Math.min(parsed, MAX_SIMULATION_HISTORY_LIMIT);
}

/**
 * Normalize GET shorthand profile payload from query params.
 */
function buildUserProfileFromQuery(query) {
  const role = typeof query.role === 'string' ? query.role.trim() : '';

  const skills =
    typeof query.skills === 'string' && query.skills.trim()
      ? query.skills
          .split(',')
          .map((skill) => skill.trim())
          .filter(Boolean)
      : [];

  const experienceYears = Number.parseFloat(query.experience_years);
  const industry =
    typeof query.industry === 'string' ? query.industry.trim() : '';

  return {
    role,
    skills,
    experience_years: Number.isFinite(experienceYears)
      ? experienceYears
      : 0,
    industry,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// POST /api/career/simulations
// ───────────────────────────────────────────────────────────────────────────────

const runSimulation = asyncHandler(async (req, res) => {
  const userId = req.user?.uid ?? req.user?.id ?? null;

  const {
    userProfile,
    marketData = {},
    includeNarrative = false,
    forceRefresh = false,
  } = req.body ?? {};

  if (!userProfile?.role || typeof userProfile.role !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'userProfile.role is required',
    });
  }

  logger.info('[DigitalTwinController] runSimulation:start', {
    userId,
    role: userProfile.role,
    includeNarrative: Boolean(includeNarrative),
    forceRefresh: Boolean(forceRefresh),
  });

  const result = await digitalTwinService.runSimulation({
    userId,
    userProfile,
    marketData,
    includeNarrative: Boolean(includeNarrative),
    forceRefresh: Boolean(forceRefresh),
  });

  const careerPaths = Array.isArray(result?.career_paths)
    ? result.career_paths
    : [];

  logger.info('[DigitalTwinController] runSimulation:success', {
    userId,
    role: userProfile.role,
    cached: Boolean(result?.cached),
    pathCount: careerPaths.length,
  });

  return res.status(200).json({
    success: true,
    data: result,
    meta: {
      cached: Boolean(result?.cached),
      path_count: careerPaths.length,
      requested_at: new Date().toISOString(),
    },
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// GET /api/career/simulations
// ───────────────────────────────────────────────────────────────────────────────

const getSimulations = asyncHandler(async (req, res) => {
  const userId = req.user?.uid ?? req.user?.id ?? null;
  const limit = normalizeLimit(req.query?.limit);

  const records = await digitalTwinService.getStoredSimulations(
    userId,
    limit
  );

  const safeRecords = Array.isArray(records) ? records : [];

  return res.status(200).json({
    success: true,
    data: safeRecords,
    meta: {
      count: safeRecords.length,
      requested_at: new Date().toISOString(),
    },
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// GET /api/career/future-paths
// ───────────────────────────────────────────────────────────────────────────────

const getFuturePaths = asyncHandler(async (req, res) => {
  const userId = req.user?.uid ?? req.user?.id ?? null;
  const userProfile = buildUserProfileFromQuery(req.query ?? {});

  if (!userProfile.role) {
    return res.status(400).json({
      success: false,
      error: 'Query param "role" is required',
    });
  }

  logger.info('[DigitalTwinController] getFuturePaths:start', {
    userId,
    role: userProfile.role,
  });

  const result = await digitalTwinService.runSimulation({
    userId,
    userProfile,
    includeNarrative: false,
    forceRefresh: false,
  });

  const careerPaths = Array.isArray(result?.career_paths)
    ? result.career_paths
    : [];

  return res.status(200).json({
    career_paths: careerPaths.map((path) => ({
      path: path?.path ?? null,
      salary_projection: path?.salary_projection ?? null,
      growth_score: path?.growth_score ?? null,
      risk_level: path?.risk_level ?? null,
      skills_required: Array.isArray(path?.skills_required)
        ? path.skills_required
        : [],
      next_role: path?.next_role ?? null,
      transition_months: path?.transition_months ?? null,
      total_years: path?.total_years ?? null,
      strategy: path?.strategy_label ?? null,
    })),
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// DELETE /api/career/simulations/cache
// ───────────────────────────────────────────────────────────────────────────────

const invalidateCache = asyncHandler(async (req, res) => {
  const userId = req.user?.uid ?? req.user?.id ?? null;
  const role =
    typeof req.body?.role === 'string' ? req.body.role.trim() : undefined;

  await digitalTwinService.invalidateUserCache(userId, role);

  logger.info('[DigitalTwinController] invalidateCache:success', {
    userId,
    role,
  });

  return res.status(200).json({
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