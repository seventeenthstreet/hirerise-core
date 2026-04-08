'use strict';

/**
 * adminCmsRoles.controller.js — Supabase Optimized Version
 *
 * Security contract:
 *   adminId = req.user.id
 *   agency  = req.user.agency
 */

const { asyncHandler } = require('../../../../utils/helpers');
const rolesService     = require('./adminCmsRoles.service');

// ─────────────────────────────────────────────
// CREATE ROLE
// ─────────────────────────────────────────────
const createRole = asyncHandler(async (req, res) => {
  const adminId = req.user?.uid;
  const agency  = req.user?.agency ?? null;

  if (!adminId) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const {
    name,
    jobFamilyId,
    level,
    track,
    description,
    alternativeTitles,
  } = req.body;

  // Basic validation (fast fail)
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ success: false, error: 'Role name is required' });
  }

  const role = await rolesService.createRole(
    {
      name: name.trim(),
      jobFamilyId,
      level,
      track,
      description,
      alternativeTitles,
    },
    adminId,
    agency
  );

  return res.status(201).json({
    success: true,
    data: role,
    meta: {
      createdByAdminId: adminId,
      sourceAgency: agency,
      timestamp: new Date().toISOString(),
    },
  });
});

// ─────────────────────────────────────────────
// UPDATE ROLE
// ─────────────────────────────────────────────
const updateRole = asyncHandler(async (req, res) => {
  const adminId = req.user?.uid;
  const roleId  = req.params.roleId;

  if (!adminId) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (!roleId) {
    return res.status(400).json({ success: false, error: 'Role ID is required' });
  }

  const {
    name,
    jobFamilyId,
    level,
    track,
    description,
    alternativeTitles,
  } = req.body;

  // Only include defined fields (PATCH behavior)
  const updates = Object.fromEntries(
    Object.entries({
      name: name?.trim(),
      jobFamilyId,
      level,
      track,
      description,
      alternativeTitles,
    }).filter(([_, v]) => v !== undefined)
  );

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update' });
  }

  const updated = await rolesService.updateRole(roleId, updates, adminId);

  return res.status(200).json({
    success: true,
    data: updated,
    meta: {
      updatedByAdminId: adminId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ─────────────────────────────────────────────
// LIST ROLES (OPTIMIZED)
// ─────────────────────────────────────────────
const listRoles = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const jobFamilyId = req.query.jobFamilyId || undefined;

  const result = await rolesService.listRoles({
    limit,
    jobFamilyId,
  });

  return res.status(200).json({
    success: true,
    data: {
      items: result.roles,
      total: result.total,
    },
    meta: {
      limit,
      timestamp: new Date().toISOString(),
    },
  });
});

module.exports = {
  createRole,
  updateRole,
  listRoles,
};