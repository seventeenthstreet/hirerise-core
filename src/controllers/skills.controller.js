/**
 * skills.controller.js — Skill Gap Engine Controller
 *
 * CHANGES (remediation sprint):
 *   FIX-9: Wrapped all async handlers with asyncHandler() from src/utils/helpers.js.
 *           Previously, any unhandled promise rejection from skillGapService would
 *           hang the request indefinitely — next(err) was never called.
 */

'use strict';

const { asyncHandler } = require('../utils/helpers');

const skillGapService = require('../services/skillGap.service');
const logger          = require('../utils/logger');

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
  analyzeGap,
  bulkGapAnalysis,
  getRoleSkills,
  searchSkills,
};
