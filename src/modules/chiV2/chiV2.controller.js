'use strict';

/**
 * chiV2.controller.js
 *
 * POST /api/v1/chi-v2/calculate
 * POST /api/v1/chi-v2/skill-gap
 * POST /api/v1/chi-v2/career-path
 * POST /api/v1/chi-v2/opportunities
 * POST /api/v1/chi-v2/full-intelligence
 *
 * SECURITY:
 * - authenticate middleware enforced at routes
 * - Supabase-backed read-only service orchestration
 * - no direct auth mutations
 */

const { asyncHandler } = require('../../utils/helpers');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { calculateCHI, resolveRoleId } = require('./chiV2.engine');
const { analyseSkillGap } = require('./skillGapEngine');
const { recommendCareerPath } = require('./careerPathEngine');
const { analyseCareerOpportunities } = require('./careerOpportunityEngine');
const { runIntelligence } = require('./intelligenceOrchestrator');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractProfile(body = {}) {
  return {
    current_role: body.current_role ?? null,
    target_role: body.target_role ?? null,
    skills: Array.isArray(body.skills) ? body.skills : [],
    skill_levels: Array.isArray(body.skill_levels)
      ? body.skill_levels
      : [],
    education_level: body.education_level ?? null,
    years_experience: normalizeNumber(body.years_experience, 0),
    current_salary: normalizeNumber(body.current_salary, 0)
  };
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTopN(value, fallback = 3) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 10);
}

function requireField(body, field) {
  if (!body?.[field]) {
    throw new AppError(
      `${field} is required`,
      400,
      { field },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

function success(res, data) {
  return res.json({
    success: true,
    data
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────────

// POST /calculate
const calculate = asyncHandler(async (req, res) => {
  requireField(req.body, 'target_role');

  const profile = extractProfile(req.body);

  logger.info('[CHI V2] Calculate requested', {
    target_role: profile.target_role
  });

  const result = await calculateCHI(profile);

  return success(res, result);
});

// POST /skill-gap
const skillGap = asyncHandler(async (req, res) => {
  requireField(req.body, 'target_role');

  const profile = extractProfile(req.body);
  const targetRoleId = await resolveRoleId(profile.target_role);

  if (!targetRoleId) {
    throw new AppError(
      `Target role not found: "${profile.target_role}"`,
      404,
      {},
      ErrorCodes.NOT_FOUND
    );
  }

  logger.info('[CHI V2] Skill gap requested', {
    target_role: profile.target_role,
    target_role_id: targetRoleId
  });

  const result = await analyseSkillGap(targetRoleId, profile.skills);

  return success(res, result);
});

// POST /career-path
const careerPath = asyncHandler(async (req, res) => {
  requireField(req.body, 'target_role');

  const profile = extractProfile(req.body);

  const [targetRoleId, currentRoleId] = await Promise.all([
    resolveRoleId(profile.target_role),
    profile.current_role
      ? resolveRoleId(profile.current_role)
      : Promise.resolve(null)
  ]);

  if (!targetRoleId) {
    throw new AppError(
      `Target role not found: "${profile.target_role}"`,
      404,
      {},
      ErrorCodes.NOT_FOUND
    );
  }

  logger.info('[CHI V2] Career path requested', {
    current_role: profile.current_role,
    target_role: profile.target_role
  });

  const result = await recommendCareerPath(
    currentRoleId,
    targetRoleId
  );

  return success(res, result);
});

// POST /opportunities
const opportunities = asyncHandler(async (req, res) => {
  requireField(req.body, 'current_role');

  const profile = extractProfile(req.body);
  const country = req.body?.country ?? null;
  const topN = normalizeTopN(req.body?.top_n, 3);

  const [currentRoleId, chiResult] = await Promise.all([
    resolveRoleId(profile.current_role),
    profile.target_role
      ? calculateCHI(profile).catch(error => {
          logger.warn('[CHI V2] CHI pre-score degraded', {
            error: error.message
          });
          return null;
        })
      : Promise.resolve(null)
  ]);

  if (!currentRoleId) {
    throw new AppError(
      `Current role not found: "${profile.current_role}"`,
      404,
      {},
      ErrorCodes.NOT_FOUND
    );
  }

  logger.info('[CHI V2] Opportunities requested', {
    current_role: profile.current_role,
    country,
    top_n: topN
  });

  const result = await analyseCareerOpportunities(
    {
      current_role_id: currentRoleId,
      chi_score: chiResult?.chi_score ?? null
    },
    {
      country,
      top_n: topN
    }
  );

  return success(res, result);
});

// POST /full-intelligence
const fullIntelligence = asyncHandler(async (req, res) => {
  requireField(req.body, 'target_role');

  const profile = extractProfile(req.body);
  const options = {
    country: req.body?.country ?? null,
    top_n: normalizeTopN(req.body?.top_n, 3)
  };

  logger.info('[CHI V2] Full intelligence requested', {
    target_role: profile.target_role,
    country: options.country,
    top_n: options.top_n
  });

  const result = await runIntelligence(profile, options);

  return success(res, result);
});

module.exports = {
  calculate,
  skillGap,
  careerPath,
  opportunities,
  fullIntelligence
};