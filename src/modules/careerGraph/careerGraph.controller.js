'use strict';

const { asyncHandler } = require('../../utils/helpers');
const careerGraphService = require('./careerGraph.service');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const MAX_ROLE_SEARCH_LIMIT = 50;
const DEFAULT_ROLE_SEARCH_LIMIT = 15;
const DEFAULT_MAX_HOPS = 4;
const MAX_MAX_HOPS = 6;

const VALID_EDUCATION_LEVELS = new Set([
  'high_school',
  'diploma',
  'bachelors',
  'masters',
  'mba',
  'phd',
]);

function toSafeInt(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number.parseInt(value, 10);
  let result = Number.isFinite(parsed) ? parsed : fallback;
  if (min !== null) result = Math.max(min, result);
  if (max !== null) result = Math.min(max, result);
  return result;
}

function toSafeFloat(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number.parseFloat(value);
  let result = Number.isFinite(parsed) ? parsed : fallback;
  if (min !== null) result = Math.max(min, result);
  if (max !== null) result = Math.min(max, result);
  return result;
}

function normalizeStringArray(value) {
  if (!value) return null;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRoleId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSkills(skills) {
  if (!Array.isArray(skills)) return [];

  return skills
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase());
}

function getAuthenticatedUserId(req) {
  return req.user?.sub || null;
}

const searchRoles = asyncHandler(async (req, res) => {
  const { q, family } = req.query;

  const limit = toSafeInt(req.query.limit, DEFAULT_ROLE_SEARCH_LIMIT, {
    min: 1,
    max: MAX_ROLE_SEARCH_LIMIT,
  });

  const roles = family
    ? await careerGraphService.getRolesByFamily(String(family).trim())
    : await careerGraphService.searchRoles(q?.trim?.(), limit);

  res.status(200).json({
    success: true,
    data: { roles, count: roles.length },
  });
});

const getFamilies = asyncHandler(async (_req, res) => {
  const families = await careerGraphService.getRoleFamilies();
  res.status(200).json({ success: true, data: { families } });
});

const getRole = asyncHandler(async (req, res) => {
  const roleId = normalizeRoleId(req.params.roleId);
  const role = await careerGraphService.getRole(roleId);

  if (!role) {
    throw new AppError(
      `Role not found: ${roleId}`,
      404,
      { roleId },
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  res.status(200).json({ success: true, data: role });
});

const getRoleSkills = asyncHandler(async (req, res) => {
  const roleId = normalizeRoleId(req.params.roleId);
  const skills = await careerGraphService.getSkillsForRole(roleId);

  res.status(200).json({
    success: true,
    data: {
      role_id: roleId,
      skills,
      required: skills.filter((s) => s.importance === 'required'),
      preferred: skills.filter((s) => s.importance === 'preferred'),
      total: skills.length,
    },
  });
});

const getSkillGap = asyncHandler(async (req, res) => {
  const { roleId, userSkills } = req.body;

  const result = await careerGraphService.getSkillGap(
    normalizeSkills(userSkills),
    normalizeRoleId(roleId)
  );

  res.status(200).json({ success: true, data: result });
});

const getTransitions = asyncHandler(async (req, res) => {
  const roleId = normalizeRoleId(req.params.roleId);

  const transitions = await careerGraphService.getTransitions(roleId, {
    types: normalizeStringArray(req.query.types),
    maxDifficulty: toSafeInt(req.query.maxDifficulty, 100, {
      min: 0,
      max: 100,
    }),
  });

  res.status(200).json({
    success: true,
    data: { role_id: roleId, transitions, count: transitions.length },
  });
});

const getCareerPath = asyncHandler(async (req, res) => {
  const roleId = normalizeRoleId(req.params.roleId);

  const result = await careerGraphService.getCareerPath(roleId, {
    maxHops: toSafeInt(req.query.maxHops, DEFAULT_MAX_HOPS, {
      min: 1,
      max: MAX_MAX_HOPS,
    }),
    types: normalizeStringArray(req.query.types),
    maxDifficulty: toSafeInt(req.query.maxDifficulty, 100, {
      min: 0,
      max: 100,
    }),
  });

  res.status(200).json({ success: true, data: result });
});

const getSalaryBenchmark = asyncHandler(async (req, res) => {
  const roleId = normalizeRoleId(req.params.roleId);

  const result = await careerGraphService.getSalaryBenchmark(roleId, {
    country: req.query.country || 'IN',
    experienceYears:
      req.query.experienceYears !== undefined
        ? toSafeFloat(req.query.experienceYears, null, { min: 0 })
        : null,
    currency: req.query.currency || null,
  });

  if (!result) {
    throw new AppError(
      `No salary data for role: ${roleId}`,
      404,
      { roleId },
      ErrorCodes.NOT_FOUND
    );
  }

  res.status(200).json({ success: true, data: result });
});

const getEducationMatch = asyncHandler(async (req, res) => {
  const roleId = normalizeRoleId(req.params.roleId);
  const level = req.query.level?.trim?.();

  if (level && !VALID_EDUCATION_LEVELS.has(level)) {
    throw new AppError(
      'Invalid education level',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const result = await careerGraphService.getEducationMatch(roleId, level);
  res.status(200).json({ success: true, data: result });
});

const computeCHI = asyncHandler(async (req, res) => {
  const result = await careerGraphService.computeGraphCHI({
    ...req.body,
    targetRoleId: req.body.targetRoleId
      ? normalizeRoleId(req.body.targetRoleId)
      : null,
    currentRoleId: req.body.currentRoleId
      ? normalizeRoleId(req.body.currentRoleId)
      : null,
    userSkills: normalizeSkills(req.body.userSkills),
    experienceYears: toSafeFloat(req.body.experienceYears, 0, { min: 0 }),
  });

  res.status(200).json({ success: true, data: result });
});

const computeOnboardingInsights = asyncHandler(async (req, res) => {
  const result = await careerGraphService.computeOnboardingInsights({
    ...req.body,
    userId: getAuthenticatedUserId(req),
    targetRoleId: req.body.targetRoleId
      ? normalizeRoleId(req.body.targetRoleId)
      : null,
    currentRoleId: req.body.currentRoleId
      ? normalizeRoleId(req.body.currentRoleId)
      : null,
    userSkills: normalizeSkills(req.body.userSkills),
    experienceYears: toSafeFloat(req.body.experienceYears, 0, { min: 0 }),
  });

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