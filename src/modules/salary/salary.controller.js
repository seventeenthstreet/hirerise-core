'use strict';

/**
 * src/modules/salary/salary.controller.js
 *
 * Salary Data HTTP Handlers
 *
 * Supabase-ready controller:
 * - Firebase auth assumptions removed
 * - Backward-compatible user identity fallback preserved
 * - Safer filter normalization
 * - Better null safety
 * - Cleaner request parsing
 * - Stable API response shape preserved
 *
 * @module modules/salary/salary.controller
 */

const {
  createSalaryRecord,
  getAggregatedSalary,
  listSalaryRecords,
} = require('./salary.service');

const { asyncHandler } = require('../../utils/helpers');

/**
 * Build safe salary filters from request query.
 * Keeps only supported filter keys.
 *
 * @param {object} query
 * @returns {object}
 */
function buildSalaryFilters(query = {}) {
  const filters = {};

  if (query.location != null && query.location !== '') {
    filters.location = String(query.location).trim();
  }

  if (query.experienceLevel != null && query.experienceLevel !== '') {
    filters.experienceLevel = String(query.experienceLevel).trim();
  }

  if (query.industry != null && query.industry !== '') {
    filters.industry = String(query.industry).trim();
  }

  return filters;
}

/**
 * Extract authenticated user ID in a provider-agnostic way.
 * Supports:
 * - Supabase auth middleware → req.user.id
 * - Legacy Firebase middleware → req.user.id
 *
 * @param {object} user
 * @returns {string|null}
 */
function getAuthenticatedUserId(user) {
  if (!user || typeof user !== 'object') return null;
  return user.id || user.uid || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/salary-data/:roleId
// ─────────────────────────────────────────────────────────────────────────────
const getAggregated = asyncHandler(async (req, res) => {
  const roleId = req.params?.roleId;
  const filters = buildSalaryFilters(req.query);

  const data = await getAggregatedSalary(roleId, filters);

  return res.status(200).json({
    success: true,
    data,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/salary-data/:roleId/records
// ─────────────────────────────────────────────────────────────────────────────
const getRawRecords = asyncHandler(async (req, res) => {
  const roleId = req.params?.roleId;

  const records = await listSalaryRecords(roleId);

  return res.status(200).json({
    success: true,
    data: records,
    count: Array.isArray(records) ? records.length : 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/salary-data
// ─────────────────────────────────────────────────────────────────────────────
const createRecord = asyncHandler(async (req, res) => {
  const adminId = getAuthenticatedUserId(req.user);
  const record = req.body;
  const ipAddress = req.ip || req.headers['x-forwarded-for'] || null;

  const created = await createSalaryRecord(record, adminId, ipAddress);

  return res.status(201).json({
    success: true,
    data: created,
  });
});

module.exports = {
  getAggregated,
  getRawRecords,
  createRecord,
};