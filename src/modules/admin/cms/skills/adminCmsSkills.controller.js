'use strict';

/**
 * adminCmsSkills.controller.js — HTTP handlers for Admin CMS Skills
 *
 * Security contract:
 *   - adminId is ALWAYS req.user.uid — never req.body.adminId
 *   - agency is ALWAYS req.user.agency — never req.body.agency
 *   - Middleware chain enforced in routes: authenticate → requireAdmin → handler
 *
 * Response envelope:
 *   All responses follow the existing HireRise envelope:
 *   { success: true, data: {...} }      (success)
 *   { success: false, error: { code, message }, details: {...} }  (failure)
 *
 * @module modules/admin/cms/skills/adminCmsSkills.controller
 */

const { asyncHandler } = require('../../../../utils/helpers');
const skillsService    = require('./adminCmsSkills.service');
const logger           = require('../../../../utils/logger');

// ── POST /api/v1/admin/cms/skills ────────────────────────────────────────────

const createSkill = asyncHandler(async (req, res) => {
  // ⚠ SECURITY: adminId and agency come from the JWT — never from req.body
  const adminId = req.user.uid;
  const agency  = req.user.agency ?? null;

  const { name, category, aliases, description, demandScore } = req.body;

  const skill = await skillsService.createSkill(
    { name, category, aliases, description, demandScore },
    adminId,
    agency
  );

  return res.status(201).json({
    success: true,
    data:    skill,
    meta: {
      createdByAdminId: adminId,
      sourceAgency:     agency,
      createdAt:        new Date().toISOString(),
    },
  });
});

// ── PATCH /api/v1/admin/cms/skills/:skillId ──────────────────────────────────

const updateSkill = asyncHandler(async (req, res) => {
  const adminId  = req.user.uid;
  const skillId  = req.params.skillId;

  // Strip any injected identity fields from the update payload
  const { name, category, aliases, description, demandScore } = req.body;
  const updates = {};
  if (name        !== undefined) updates.name        = name;
  if (category    !== undefined) updates.category    = category;
  if (aliases     !== undefined) updates.aliases     = aliases;
  if (description !== undefined) updates.description = description;
  if (demandScore !== undefined) updates.demandScore = demandScore;

  const updated = await skillsService.updateSkill(skillId, updates, adminId);

  return res.status(200).json({ success: true, data: updated });
});

// ── GET /api/v1/admin/cms/skills ─────────────────────────────────────────────

const listSkills = asyncHandler(async (req, res) => {
  const { limit, category } = req.query;

  const result = await skillsService.listSkills({
    limit:    limit ? Math.min(parseInt(limit, 10), 500) : 100,
    category: category || undefined,
  });

  return res.status(200).json({ success: true, data: { items: result.skills, total: result.total } });
});

module.exports = { createSkill, updateSkill, listSkills };








