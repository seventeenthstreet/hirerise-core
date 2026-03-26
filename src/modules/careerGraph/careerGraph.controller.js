'use strict';

/**
 * careerGraph.controller.js — Career Graph API Controllers
 *
 * All responses use the standard project envelope:
 *   { success: true, data: {} }
 *   { success: false, error: { code, message } }
 */

const { asyncHandler } = require('../../utils/helpers');
const careerGraphService = require('./careerGraph.service');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// ── GET /api/v1/career-graph/roles ────────────────────────────────────────────
const searchRoles = asyncHandler(async (req, res) => {
  const { q, family, limit = 15 } = req.query;

  let roles;
  if (family) {
    roles = await careerGraphService.getRolesByFamily(family);
  } else {
    roles = await careerGraphService.searchRoles(q, Math.min(parseInt(limit, 10) || 15, 50));
  }

  res.status(200).json({
    success: true,
    data: {
      roles,
      count: roles.length,
    },
  });
});

// ── GET /api/v1/career-graph/families ────────────────────────────────────────
const getFamilies = asyncHandler(async (req, res) => {
  const families = await careerGraphService.getRoleFamilies();
  res.status(200).json({ success: true, data: { families } });
});

// ── GET /api/v1/career-graph/roles/:roleId ───────────────────────────────────
const getRole = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const role = await careerGraphService.getRole(roleId);

  if (!role) {
    throw new AppError(`Role not found: ${roleId}`, 404, { roleId }, ErrorCodes.ROLE_NOT_FOUND);
  }

  res.status(200).json({ success: true, data: role });
});

// ── GET /api/v1/career-graph/roles/:roleId/skills ────────────────────────────
const getRoleSkills = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const skills = await careerGraphService.getSkillsForRole(roleId);

  res.status(200).json({
    success: true,
    data: {
      role_id:    roleId,
      skills,
      required:   skills.filter(s => s.importance === 'required'),
      preferred:  skills.filter(s => s.importance === 'preferred'),
      total:      skills.length,
    },
  });
});

// ── POST /api/v1/career-graph/skill-gap ──────────────────────────────────────
const getSkillGap = asyncHandler(async (req, res) => {
  const { roleId, userSkills = [] } = req.body;

  if (!roleId) {
    throw new AppError('roleId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const result = await careerGraphService.getSkillGap(userSkills, roleId);

  res.status(200).json({ success: true, data: result });
});

// ── GET /api/v1/career-graph/roles/:roleId/transitions ───────────────────────
const getTransitions = asyncHandler(async (req, res) => {
  const { roleId }      = req.params;
  const { types, minProbability = 0.1 } = req.query;

  const transitions = await careerGraphService.getTransitions(roleId, {
    types:          types ? types.split(',') : null,
    minProbability: parseFloat(minProbability),
  });

  res.status(200).json({
    success: true,
    data: { role_id: roleId, transitions, count: transitions.length },
  });
});

// ── GET /api/v1/career-graph/roles/:roleId/path ──────────────────────────────
const getCareerPath = asyncHandler(async (req, res) => {
  const { roleId }                 = req.params;
  const { maxHops = 4, types, minProbability = 0.15 } = req.query;

  const result = await careerGraphService.getCareerPath(roleId, {
    maxHops:        Math.min(parseInt(maxHops, 10) || 4, 6),
    types:          types ? types.split(',') : null,
    minProbability: parseFloat(minProbability),
  });

  res.status(200).json({ success: true, data: result });
});

// ── GET /api/v1/career-graph/roles/:roleId/salary ────────────────────────────
const getSalaryBenchmark = asyncHandler(async (req, res) => {
  const { roleId }                          = req.params;
  const { country = 'IN', experienceYears, currency } = req.query;

  const result = await careerGraphService.getSalaryBenchmark(roleId, {
    country,
    experienceYears: experienceYears ? parseFloat(experienceYears) : null,
    currency,
  });

  if (!result) {
    throw new AppError(`No salary data for role: ${roleId}`, 404, { roleId }, ErrorCodes.NOT_FOUND);
  }

  res.status(200).json({ success: true, data: result });
});

// ── GET /api/v1/career-graph/roles/:roleId/education ────────────────────────
const getEducationMatch = asyncHandler(async (req, res) => {
  const { roleId }      = req.params;
  const { level }       = req.query;

  const VALID_LEVELS = ['high_school', 'diploma', 'bachelors', 'masters', 'mba', 'phd'];
  if (level && !VALID_LEVELS.includes(level)) {
    throw new AppError(
      `Invalid education level. Must be one of: ${VALID_LEVELS.join(', ')}`,
      400, {}, ErrorCodes.VALIDATION_ERROR
    );
  }

  const result = await careerGraphService.getEducationMatch(roleId, level);
  res.status(200).json({ success: true, data: result });
});

// ── POST /api/v1/career-graph/chi ────────────────────────────────────────────
const computeCHI = asyncHandler(async (req, res) => {
  const {
    targetRoleId, targetRoleName,
    currentRoleId, currentRoleName,
    userSkills       = [],
    experienceYears  = 0,
    educationLevel   = null,
    currentSalaryAnnual = null,
    country          = 'IN',
  } = req.body;

  if (!targetRoleId && !targetRoleName) {
    throw new AppError(
      'targetRoleId or targetRoleName is required',
      400, {}, ErrorCodes.VALIDATION_ERROR
    );
  }

  const result = await careerGraphService.computeGraphCHI({
    targetRoleId, targetRoleName,
    currentRoleId, currentRoleName,
    userSkills, experienceYears,
    educationLevel, currentSalaryAnnual,
    country,
  });

  res.status(200).json({ success: true, data: result });
});

// ── POST /api/v1/career-graph/onboarding-insights ────────────────────────────
const computeOnboardingInsights = asyncHandler(async (req, res) => {
  const userId = req.user?.uid;
  const {
    targetRoleId, targetRoleName,
    currentRoleId, currentRoleName,
    userSkills       = [],
    experienceYears  = 0,
    educationLevel   = null,
    currentSalaryAnnual = null,
    country          = 'IN',
  } = req.body;

  if (!targetRoleId && !targetRoleName) {
    throw new AppError(
      'targetRoleId or targetRoleName is required',
      400, {}, ErrorCodes.VALIDATION_ERROR
    );
  }

  const result = await careerGraphService.computeOnboardingInsights({
    targetRoleId, targetRoleName,
    currentRoleId, currentRoleName,
    userSkills, experienceYears,
    educationLevel, currentSalaryAnnual,
    country,
  });

  if (!result) {
    throw new AppError('Could not resolve target role', 422, {}, ErrorCodes.VALIDATION_ERROR);
  }

  res.status(200).json({ success: true, data: result });
});

module.exports = {
  searchRoles,
  getFamilies,
  getRole,
  getRoleSkills,
  getSkillGap,
  getTransitions,
  getCareerPath,
  getSalaryBenchmark,
  getEducationMatch,
  computeCHI,
  computeOnboardingInsights,
};








