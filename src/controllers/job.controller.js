/**
 * job.controller.js — Job Roles & Families Controller
 *
 * CHANGES (remediation sprint):
 *   FIX-9: Wrapped all async handlers with asyncHandler() from src/utils/helpers.js.
 *           Previously any Firestore error from jobService would hang the connection
 *           permanently — errorHandler was never invoked.
 *   FIX-8c: listRoles meta now forwards the hasMore field from job.service.js so
 *            frontend can implement pagination correctly.
 */

'use strict';

const { asyncHandler } = require('../utils/helpers');
const jobService       = require('../services/job.service');

const listJobFamilies = asyncHandler(async (req, res) => {
  const families = await jobService.listJobFamilies();
  res.status(200).json({
    success: true,
    data: families,
    meta: { count: families.length },
  });
});

const listRoles = asyncHandler(async (req, res) => {
  const { familyId, level, track, limit, page } = req.query;
  const result = await jobService.listRoles({ familyId, level, track, limit, page });

  res.status(200).json({
    success: true,
    data: result.roles,
    meta: {
      page:    result.page,
      limit:   result.limit,
      count:   result.count,
      hasMore: result.hasMore, // FIX-8c: frontend now knows if more pages exist
    },
  });
});

const getRoleById = asyncHandler(async (req, res) => {
  const role = await jobService.getRoleById(req.params.roleId);
  res.status(200).json({ success: true, data: role });
});

module.exports = { listJobFamilies, listRoles, getRoleById };









