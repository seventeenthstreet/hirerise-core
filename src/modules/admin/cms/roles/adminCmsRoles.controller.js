'use strict';

/**
 * adminCmsRoles.controller.js — HTTP handlers for Admin CMS Roles
 *
 * Security contract:
 *   adminId = req.user.uid  (always from JWT, never from body)
 *   agency  = req.user.agency (always from JWT, never from body)
 */

const { asyncHandler } = require('../../../../utils/helpers');
const rolesService     = require('./adminCmsRoles.service');

const createRole = asyncHandler(async (req, res) => {
  const adminId = req.user.uid;
  const agency  = req.user.agency ?? null;

  const { name, jobFamilyId, level, track, description, alternativeTitles } = req.body;

  const role = await rolesService.createRole(
    { name, jobFamilyId, level, track, description, alternativeTitles },
    adminId,
    agency
  );

  return res.status(201).json({
    success: true,
    data:    role,
    meta: {
      createdByAdminId: adminId,
      sourceAgency:     agency,
      createdAt:        new Date().toISOString(),
    },
  });
});

const updateRole = asyncHandler(async (req, res) => {
  const adminId = req.user.uid;
  const roleId  = req.params.roleId;

  const { name, jobFamilyId, level, track, description, alternativeTitles } = req.body;
  const updates = {};
  if (name              !== undefined) updates.name              = name;
  if (jobFamilyId       !== undefined) updates.jobFamilyId       = jobFamilyId;
  if (level             !== undefined) updates.level             = level;
  if (track             !== undefined) updates.track             = track;
  if (description       !== undefined) updates.description       = description;
  if (alternativeTitles !== undefined) updates.alternativeTitles = alternativeTitles;

  const updated = await rolesService.updateRole(roleId, updates, adminId);
  return res.status(200).json({ success: true, data: updated });
});

const listRoles = asyncHandler(async (req, res) => {
  const { limit, jobFamilyId } = req.query;
  const result = await rolesService.listRoles({
    limit:       limit ? Math.min(parseInt(limit, 10), 500) : 100,
    jobFamilyId: jobFamilyId || undefined,
  });
  return res.status(200).json({ success: true, data: { items: result.roles, total: result.total } });
});

module.exports = { createRole, updateRole, listRoles };








