'use strict';

const { asyncHandler }   = require('../../utils/helpers');
const svc                = require('./skillGraph.service');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// ── GET /api/v1/skill-graph/skills ────────────────────────────────────────────
const listSkills = asyncHandler(async (req, res) => {
  const { category, limit = 200 } = req.query;
  const skills = await svc.getAllSkills({ category, limit: parseInt(limit, 10) });
  res.json({ success: true, data: { skills, count: skills.length } });
});

// ── GET /api/v1/skill-graph/skills/search ─────────────────────────────────────
const searchSkills = asyncHandler(async (req, res) => {
  const { q, category, limit = 20 } = req.query;
  if (!q || q.trim().length < 2) {
    throw new AppError('q must be at least 2 characters', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }
  const skills = await svc.searchSkills(q, { category, limit: parseInt(limit, 10) });
  res.json({ success: true, data: { skills, count: skills.length } });
});

// ── GET /api/v1/skill-graph/skills/:skillId ───────────────────────────────────
const getSkill = asyncHandler(async (req, res) => {
  const { skillId } = req.params;
  const skill = await svc.getSkill(skillId);
  if (!skill) throw new AppError(`Skill not found: ${skillId}`, 404, { skillId }, ErrorCodes.NOT_FOUND);

  const [relationships, prerequisites, advanced, related] = await Promise.all([
    svc.getRelationships(skillId),
    svc.getPrerequisites(skillId, false),  // shallow for single skill view
    svc.getAdvancedSkills(skillId),
    svc.getRelatedSkills(skillId),
  ]);

  res.json({
    success: true,
    data: {
      ...skill,
      relationships,
      prerequisites,
      advanced_skills: advanced,
      related_skills:  related,
    },
  });
});

// ── GET /api/v1/skill-graph/skills/:skillId/prerequisites ─────────────────────
const getPrerequisites = asyncHandler(async (req, res) => {
  const { skillId }  = req.params;
  const { deep = 'true' } = req.query;
  const prereqs = await svc.getPrerequisites(skillId, deep !== 'false');
  res.json({
    success: true,
    data: {
      skill_id:     skillId,
      prerequisites: prereqs,
      count:         prereqs.length,
    },
  });
});

// ── GET /api/v1/skill-graph/skills/:skillId/learning-path ────────────────────
const getLearningPath = asyncHandler(async (req, res) => {
  const { skillId } = req.params;
  const userSkills  = req.query.userSkills
    ? req.query.userSkills.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const path = await svc.generateLearningPath(skillId, userSkills);
  res.json({ success: true, data: path });
});

// ── GET /api/v1/skill-graph/roles/:roleId/skills ─────────────────────────────
const getRoleSkillMap = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const map = await svc.getRoleSkillMap(roleId);
  res.json({ success: true, data: map });
});

// ── POST /api/v1/skill-graph/gap ─────────────────────────────────────────────
const detectGap = asyncHandler(async (req, res) => {
  const { roleId, userSkills = [] } = req.body;
  if (!roleId) throw new AppError('roleId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const result = await svc.detectGap(userSkills, roleId);
  res.json({ success: true, data: result });
});

// ── POST /api/v1/skill-graph/learning-paths ───────────────────────────────────
const generateLearningPaths = asyncHandler(async (req, res) => {
  const { roleId, userSkills = [] } = req.body;
  if (!roleId) throw new AppError('roleId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const result = await svc.generateLearningPaths(userSkills, roleId);
  res.json({ success: true, data: result });
});

// ── POST /api/v1/skill-graph/intelligence ────────────────────────────────────
const getSkillIntelligence = asyncHandler(async (req, res) => {
  const { roleId, userSkills = [], chiWeight, country } = req.body;
  if (!roleId) throw new AppError('roleId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const result = await svc.getSkillIntelligence(userSkills, roleId, {
    weight:  chiWeight ? parseFloat(chiWeight) : 0.30,
    country: country || 'IN',
  });
  res.json({ success: true, data: result });
});

// ── POST /api/v1/skill-graph/chi-score ───────────────────────────────────────
const computeChiScore = asyncHandler(async (req, res) => {
  const { roleId, userSkills = [], weight = 0.30 } = req.body;
  if (!roleId) throw new AppError('roleId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const result = await svc.computeSkillScore(userSkills, roleId, parseFloat(weight));
  res.json({ success: true, data: result });
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








