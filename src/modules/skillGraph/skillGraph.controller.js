'use strict';

const { asyncHandler } = require('../../utils/helpers');
const svc = require('./skillGraph.service');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

/**
 * Shared parsers
 */
function parsePositiveInt(value, fallback, max = 1000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseFloatSafe(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function requireRoleId(roleId) {
  if (!roleId || typeof roleId !== 'string' || !roleId.trim()) {
    throw new AppError(
      'roleId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }
  return roleId.trim();
}

// ── GET /api/v1/skill-graph/skills ────────────────────────────────────────────
const listSkills = asyncHandler(async (req, res) => {
  const category = req.query.category?.trim();
  const limit = parsePositiveInt(req.query.limit, 200, 500);

  const skills = await svc.getAllSkills({
    category,
    limit,
  });

  return res.json({
    success: true,
    data: {
      skills,
      count: skills.length,
    },
  });
});

// ── GET /api/v1/skill-graph/skills/search ─────────────────────────────────────
const searchSkills = asyncHandler(async (req, res) => {
  const q = req.query.q?.trim();
  const category = req.query.category?.trim();
  const limit = parsePositiveInt(req.query.limit, 20, 100);

  if (!q || q.length < 2) {
    throw new AppError(
      'q must be at least 2 characters',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const skills = await svc.searchSkills(q, {
    category,
    limit,
  });

  return res.json({
    success: true,
    data: {
      skills,
      count: skills.length,
    },
  });
});

// ── GET /api/v1/skill-graph/skills/:skillId ───────────────────────────────────
const getSkill = asyncHandler(async (req, res) => {
  const skillId = req.params.skillId?.trim();

  const skill = await svc.getSkill(skillId);

  if (!skill) {
    throw new AppError(
      `Skill not found: ${skillId}`,
      404,
      { skillId },
      ErrorCodes.NOT_FOUND
    );
  }

  const [
    relationships,
    prerequisites,
    advancedSkills,
    relatedSkills,
  ] = await Promise.all([
    svc.getRelationships(skillId),
    svc.getPrerequisites(skillId, false),
    svc.getAdvancedSkills(skillId),
    svc.getRelatedSkills(skillId),
  ]);

  return res.json({
    success: true,
    data: {
      ...skill,
      relationships,
      prerequisites,
      advanced_skills: advancedSkills,
      related_skills: relatedSkills,
    },
  });
});

// ── GET /api/v1/skill-graph/skills/:skillId/prerequisites ─────────────────────
const getPrerequisites = asyncHandler(async (req, res) => {
  const skillId = req.params.skillId?.trim();
  const deep = req.query.deep !== 'false';

  const prerequisites = await svc.getPrerequisites(skillId, deep);

  return res.json({
    success: true,
    data: {
      skill_id: skillId,
      prerequisites,
      count: prerequisites.length,
    },
  });
});

// ── GET /api/v1/skill-graph/skills/:skillId/learning-path ────────────────────
const getLearningPath = asyncHandler(async (req, res) => {
  const skillId = req.params.skillId?.trim();
  const userSkills = parseStringArray(req.query.userSkills);

  const path = await svc.generateLearningPath(skillId, userSkills);

  return res.json({
    success: true,
    data: path,
  });
});

// ── GET /api/v1/skill-graph/roles/:roleId/skills ──────────────────────────────
const getRoleSkillMap = asyncHandler(async (req, res) => {
  const roleId = requireRoleId(req.params.roleId);

  const map = await svc.getRoleSkillMap(roleId);

  return res.json({
    success: true,
    data: map,
  });
});

// ── POST /api/v1/skill-graph/gap ──────────────────────────────────────────────
const detectGap = asyncHandler(async (req, res) => {
  const roleId = requireRoleId(req.body.roleId);
  const userSkills = parseStringArray(req.body.userSkills);

  const result = await svc.detectGap(userSkills, roleId);

  return res.json({
    success: true,
    data: result,
  });
});

// ── POST /api/v1/skill-graph/learning-paths ───────────────────────────────────
const generateLearningPaths = asyncHandler(async (req, res) => {
  const roleId = requireRoleId(req.body.roleId);
  const userSkills = parseStringArray(req.body.userSkills);

  const result = await svc.generateLearningPaths(userSkills, roleId);

  return res.json({
    success: true,
    data: result,
  });
});

// ── POST /api/v1/skill-graph/intelligence ─────────────────────────────────────
const getSkillIntelligence = asyncHandler(async (req, res) => {
  const roleId = requireRoleId(req.body.roleId);
  const userSkills = parseStringArray(req.body.userSkills);
  const weight = parseFloatSafe(req.body.chiWeight, 0.3);
  const country = req.body.country?.trim() || 'IN';

  const result = await svc.getSkillIntelligence(userSkills, roleId, {
    weight,
    country,
  });

  return res.json({
    success: true,
    data: result,
  });
});

// ── POST /api/v1/skill-graph/chi-score ────────────────────────────────────────
const computeChiScore = asyncHandler(async (req, res) => {
  const roleId = requireRoleId(req.body.roleId);
  const userSkills = parseStringArray(req.body.userSkills);
  const weight = parseFloatSafe(req.body.weight, 0.3);

  const result = await svc.computeSkillScore(userSkills, roleId, weight);

  return res.json({
    success: true,
    data: result,
  });
});

module.exports = {
  listSkills,
  searchSkills,
  getSkill,
  getPrerequisites,
  getLearningPath,
  getRoleSkillMap,
  detectGap,
  generateLearningPaths,
  getSkillIntelligence,
  computeChiScore,
};