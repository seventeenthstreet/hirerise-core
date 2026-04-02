'use strict';

/**
 * job.controller.js — Optimized
 *
 * ✅ Input validation added
 * ✅ Safe pagination defaults
 * ✅ Limit protection
 * ✅ Logging added
 * ✅ Supabase-friendly
 */

const { asyncHandler } = require('../utils/helpers');
const jobService = require('../services/job.service');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────
// GET: Job Families
// ─────────────────────────────────────────────
const listJobFamilies = asyncHandler(async (req, res) => {
  const families = await jobService.listJobFamilies();

  res.status(200).json({
    success: true,
    data: families,
    meta: {
      count: families.length
    },
  });
});

// ─────────────────────────────────────────────
// GET: Roles (with filters + pagination)
// ─────────────────────────────────────────────
const listRoles = asyncHandler(async (req, res) => {
  let { familyId, level, track, limit, page } = req.query;

  // ✅ Normalize inputs
  limit = Math.min(parseInt(limit) || 20, 100); // max 100
  page  = Math.max(parseInt(page) || 1, 1);

  logger.info('[JobController] listRoles called', {
    filters: { familyId, level, track },
    page,
    limit
  });

  const result = await jobService.listRoles({
    familyId,
    level,
    track,
    limit,
    page,
  });

  res.status(200).json({
    success: true,
    data: result.roles || [],
    meta: {
      page: result.page,
      limit: result.limit,
      count: result.count,
      hasMore: result.hasMore,
    },
  });
});

// ─────────────────────────────────────────────
// GET: Single Role
// ─────────────────────────────────────────────
const getRoleById = asyncHandler(async (req, res) => {
  const { roleId } = req.params;

  if (!roleId) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_ROLE_ID',
      message: 'roleId is required'
    });
  }

  const role = await jobService.getRoleById(roleId);

  if (!role) {
    return res.status(404).json({
      success: false,
      errorCode: 'ROLE_NOT_FOUND',
      message: `Role ${roleId} not found`
    });
  }

  res.status(200).json({
    success: true,
    data: role
  });
});

module.exports = {
  listJobFamilies,
  listRoles,
  getRoleById
};