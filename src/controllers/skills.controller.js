'use strict';

/**
 * skills.controller.js — Optimized Production Version
 *
 * ✅ Performance optimized
 * ✅ Better logging
 * ✅ Safer validation
 * ✅ Lightweight caching
 * ✅ No breaking changes
 */

const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const skillGapService = require('../services/skillGap.service');
const skillRepository = require('../repositories/skillRepository');

const skillsRepo = new skillRepository();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const sanitize = (val) =>
  val ? String(val).trim().slice(0, 100) : null;

const limitArray = (arr, max) =>
  Array.isArray(arr) ? arr.slice(0, max) : [];

// 🔥 Simple in-memory cache (for search)
const searchCache = new Map();

// ─────────────────────────────────────────────
// READ (JSON repo)
// ─────────────────────────────────────────────

const listSkills = asyncHandler(async (req, res) => {
  const start = Date.now();

  const skills = await skillsRepo.getAllWithAliases();

  logger.debug('[Skills] listSkills', {
    count: skills.length,
    timeMs: Date.now() - start,
  });

  res.status(200).json({
    success: true,
    data: skills,
    meta: {
      count: skills.length,
      source: 'static-json',
      requestedAt: new Date().toISOString(),
    },
  });
});

const getSkillById = asyncHandler(async (req, res) => {
  const name = sanitize(req.params.id);

  if (!name) {
    throw new AppError(
      'Skill name is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const skill = await skillsRepo.getByName(name);

  if (!skill) {
    throw new AppError(
      `Skill '${name}' not found`,
      404,
      {},
      ErrorCodes.SKILL_DATA_NOT_FOUND
    );
  }

  res.status(200).json({
    success: true,
    data: skill,
  });
});

// ─────────────────────────────────────────────
// WRITE (STUBS — JSON is read-only)
// ─────────────────────────────────────────────

const createSkill = asyncHandler(async (req, res) => {
  const { name } = req.body;

  if (!name) {
    throw new AppError('name is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  logger.info('[Skills] createSkill attempt', { name });

  skillsRepo.refreshCache();

  res.status(501).json({
    success: false,
    error: 'Skill creation not supported via API. Update skills.json.',
  });
});

const updateSkill = asyncHandler(async (req, res) => {
  const id = sanitize(req.params.id);

  logger.info('[Skills] updateSkill attempt', { id });

  res.status(501).json({
    success: false,
    error: 'Skill update not supported via API.',
  });
});

const deleteSkill = asyncHandler(async (req, res) => {
  const id = sanitize(req.params.id);

  logger.info('[Skills] deleteSkill attempt', { id });

  res.status(501).json({
    success: false,
    error: 'Skill deletion not supported via API.',
  });
});

// ─────────────────────────────────────────────
// SKILL GAP ENGINE
// ─────────────────────────────────────────────

const analyzeGap = asyncHandler(async (req, res) => {
  const start = Date.now();

  const {
    targetRoleId,
    userSkills = [],
    includeRecommendations = true,
  } = req.body;

  if (!targetRoleId) {
    throw new AppError('targetRoleId is required', 400);
  }

  if (!Array.isArray(userSkills)) {
    throw new AppError('userSkills must be an array', 400);
  }

  if (userSkills.length > 50) {
    throw new AppError('Maximum 50 skills allowed', 400);
  }

  const result = await skillGapService.computeGapAnalysis({
    targetRoleId,
    userSkills: limitArray(userSkills, 50),
    includeRecommendations,
  });

  logger.debug('[Skills] analyzeGap', {
    role: targetRoleId,
    skills: userSkills.length,
    timeMs: Date.now() - start,
  });

  res.status(200).json({
    success: true,
    data: result,
    meta: {
      requestedAt: new Date().toISOString(),
    },
  });
});

const bulkGapAnalysis = asyncHandler(async (req, res) => {
  const start = Date.now();

  const { targetRoleIds = [], userSkills = [] } = req.body;

  if (!Array.isArray(targetRoleIds) || targetRoleIds.length === 0) {
    throw new AppError('targetRoleIds must be a non-empty array', 400);
  }

  if (targetRoleIds.length > 20) {
    throw new AppError('Maximum 20 roles allowed', 400);
  }

  const result = await skillGapService.computeBulkGapAnalysis({
    targetRoleIds: limitArray(targetRoleIds, 20),
    userSkills: limitArray(userSkills, 50),
  });

  logger.debug('[Skills] bulkGapAnalysis', {
    roles: targetRoleIds.length,
    timeMs: Date.now() - start,
  });

  res.status(200).json({
    success: true,
    data: result,
  });
});

// ─────────────────────────────────────────────
// ROLE SKILLS
// ─────────────────────────────────────────────

const getRoleSkills = asyncHandler(async (req, res) => {
  const roleId = sanitize(req.params.roleId);

  if (!roleId) {
    throw new AppError('roleId is required', 400);
  }

  const skills = await skillGapService.getRequiredSkillsForRole(roleId);

  res.status(200).json({
    success: true,
    data: skills,
  });
});

// ─────────────────────────────────────────────
// SEARCH (Optimized + Cached)
// ─────────────────────────────────────────────

const searchSkills = asyncHandler(async (req, res) => {
  const query = sanitize(req.query.q);

  if (!query) {
    throw new AppError('query (q) is required', 400);
  }

  const cacheKey = query.toLowerCase();

  if (searchCache.has(cacheKey)) {
    return res.status(200).json({
      success: true,
      data: searchCache.get(cacheKey),
      meta: { cached: true },
    });
  }

  const allSkills = await skillsRepo.getAllWithAliases();
  const q = cacheKey;

  const results = allSkills.filter(skill => {
    const name = skill.name.toLowerCase();
    return (
      name.includes(q) ||
      skill.aliases.some(a => a.toLowerCase().includes(q))
    );
  }).slice(0, 20);

  searchCache.set(cacheKey, results);

  res.status(200).json({
    success: true,
    data: results,
    meta: {
      count: results.length,
      cached: false,
    },
  });
});

module.exports = {
  listSkills,
  getSkillById,
  createSkill,
  updateSkill,
  deleteSkill,
  analyzeGap,
  bulkGapAnalysis,
  getRoleSkills,
  searchSkills,
};