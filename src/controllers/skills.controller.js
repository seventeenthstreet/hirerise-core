/**
 * skills.controller.js — Skill Gap Engine Controller
 *
 * CHANGES:
 *   FIX-9:  Wrapped all async handlers with asyncHandler() to forward
 *           unhandled rejections to the central errorHandler middleware.
 *   FIX-CRUD: Added four missing handlers (listSkills, createSkill,
 *             getSkillById, updateSkill, deleteSkill) that correspond
 *             to the five CRUD routes added to skills.routes.js.
 *
 * Middleware chain (set in server.js + routes):
 *   authenticate (server.js) → [requireAdmin for writes] → controller
 *
 * Response envelope follows the project standard:
 *   Success: { success: true, data: {} }
 *   Failure: { success: false, error: { code: '', message: '' } }
 *   (Failures are emitted by the central errorHandler in errorHandler.js)
 */

'use strict';

const { asyncHandler } = require('../utils/helpers');

const skillGapService = require('../services/skillGap.service');
const BaseRepository  = require('../repositories/BaseRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger          = require('../utils/logger');

// Shared Firestore skills collection used by CRUD handlers.
// The legacy SkillRepository reads from skills.json (static file, read-only).
// These CRUD handlers use the live Firestore 'skills' collection instead.
const skillsRepo = new BaseRepository('skills');

// ── GET /skills ───────────────────────────────────────────────────────────────
// FIX: Was MISSING — caused "Endpoint not found: GET /api/v1/skills" (404).
const listSkills = asyncHandler(async (req, res) => {
  const limit    = req.query.limit    ? Math.min(parseInt(req.query.limit, 10), 500) : 100;
  const category = req.query.category || undefined;

  const filters = [];
  if (category) {
    filters.push({ field: 'category', op: '==', value: category });
  }

  const result = await skillsRepo.find(filters, { limit });

  res.status(200).json({
    success: true,
    data:    result.docs,
    meta: {
      count:     result.count,
      limit,
      category:  category || null,
      returnedAt: new Date().toISOString(),
    },
  });
});

// ── POST /skills  (Admin only — requireAdmin applied in routes) ────────────────
// FIX: Was MISSING.
const createSkill = asyncHandler(async (req, res) => {
  const adminId = req.user.uid;
  const { name, category, aliases, description, demandScore } = req.body;

  logger.debug('[SkillsController] createSkill', { name, adminId });

  const skill = await skillsRepo.create(
    { name, category: category || 'technical', aliases: aliases || [], description, demandScore },
    adminId
  );

  res.status(201).json({
    success: true,
    data:    skill,
    meta: {
      createdByAdminId: adminId,
      createdAt:        new Date().toISOString(),
    },
  });
});

// ── GET /skills/:id ───────────────────────────────────────────────────────────
// FIX: Was MISSING.
const getSkillById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const skill = await skillsRepo.findById(id);

  if (!skill) {
    throw new AppError(
      `Skill '${id}' not found`,
      404,
      { id },
      ErrorCodes.SKILL_DATA_NOT_FOUND
    );
  }

  res.status(200).json({
    success: true,
    data:    skill,
  });
});

// ── PUT /skills/:id  (Admin only — requireAdmin applied in routes) ─────────────
// FIX: Was MISSING.
const updateSkill = asyncHandler(async (req, res) => {
  const { id }    = req.params;
  const adminId   = req.user.uid;

  // Strip any identity fields from the update payload — adminId must always
  // come from the JWT, never from the request body.
  const { name, category, aliases, description, demandScore } = req.body;
  const updates = {};
  if (name        !== undefined) updates.name        = name;
  if (category    !== undefined) updates.category    = category;
  if (aliases     !== undefined) updates.aliases     = aliases;
  if (description !== undefined) updates.description = description;
  if (demandScore !== undefined) updates.demandScore = demandScore;

  logger.debug('[SkillsController] updateSkill', { id, adminId });

  const updated = await skillsRepo.update(id, updates, adminId);

  res.status(200).json({
    success: true,
    data:    updated,
    meta: {
      updatedByAdminId: adminId,
      updatedAt:        new Date().toISOString(),
    },
  });
});

// ── DELETE /skills/:id  (Admin only — requireAdmin applied in routes) ──────────
// Soft-delete: sets softDeleted: true via BaseRepository.softDelete()
// FIX: Was MISSING.
const deleteSkill = asyncHandler(async (req, res) => {
  const { id }  = req.params;
  const adminId = req.user.uid;

  // Confirm it exists before attempting deletion
  const existing = await skillsRepo.findById(id);
  if (!existing) {
    throw new AppError(
      `Skill '${id}' not found`,
      404,
      { id },
      ErrorCodes.SKILL_DATA_NOT_FOUND
    );
  }

  logger.debug('[SkillsController] deleteSkill (soft)', { id, adminId });

  // BaseRepository.softDelete sets softDeleted: true and updatedBy: adminId
  await skillsRepo.softDelete(id, adminId);

  res.status(200).json({
    success: true,
    data:    { id, deleted: true },
    meta: {
      deletedByAdminId: adminId,
      deletedAt:        new Date().toISOString(),
    },
  });
});

// ── POST /skills/gap-analysis ─────────────────────────────────────────────────
const analyzeGap = asyncHandler(async (req, res) => {
  const {
    targetRoleId,
    userSkills             = [],
    includeRecommendations = true,
  } = req.body;

  logger.debug('[SkillsController] analyzeGap called', {
    targetRoleId,
    skillCount: userSkills.length,
  });

  const result = await skillGapService.computeGapAnalysis({
    targetRoleId,
    userSkills,
    includeRecommendations,
  });

  res.status(200).json({
    success: true,
    data:    result,
    meta: {
      userSkillsProvided: userSkills.length,
      requestedAt:        new Date().toISOString(),
    },
  });
});

// ── POST /skills/bulk-gap ─────────────────────────────────────────────────────
const bulkGapAnalysis = asyncHandler(async (req, res) => {
  const { targetRoleIds, userSkills = [] } = req.body;

  logger.debug('[SkillsController] bulkGapAnalysis called', {
    targetCount: targetRoleIds.length,
    skillCount:  userSkills.length,
  });

  const results = await skillGapService.computeBulkGapAnalysis({
    targetRoleIds,
    userSkills,
  });

  res.status(200).json({
    success: true,
    data:    results,
    meta: {
      rolesAnalyzed:      targetRoleIds.length,
      userSkillsProvided: userSkills.length,
      requestedAt:        new Date().toISOString(),
    },
  });
});

// ── GET /skills/role/:roleId ──────────────────────────────────────────────────
const getRoleSkills = asyncHandler(async (req, res) => {
  const { roleId } = req.params;

  const skills = await skillGapService.getRequiredSkillsForRole(roleId);

  res.status(200).json({
    success: true,
    data:    skills,
  });
});

// ── GET /skills/search ────────────────────────────────────────────────────────
const searchSkills = asyncHandler(async (req, res) => {
  const { q, category } = req.query;

  const results = await skillGapService.searchSkillsByName({ query: q, category });

  res.status(200).json({
    success: true,
    data:    results,
    meta: { count: results.length },
  });
});

module.exports = {
  // CRUD handlers (FIX: were missing)
  listSkills,
  createSkill,
  getSkillById,
  updateSkill,
  deleteSkill,
  // Skill-gap engine handlers (pre-existing)
  analyzeGap,
  bulkGapAnalysis,
  getRoleSkills,
  searchSkills,
};








