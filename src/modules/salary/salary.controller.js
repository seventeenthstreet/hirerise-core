'use strict';

/**
 * salary.controller.js — Salary Data HTTP Handlers
 *
 * OBSERVABILITY UPGRADE: passes req.ip to createSalaryRecord so it
 * can be stored in the admin audit log.
 *
 * @module modules/salary/salary.controller
 */

const {
  createSalaryRecord,
  getAggregatedSalary,
  listSalaryRecords,
} = require('./salary.service');

const { asyncHandler } = require('../../utils/helpers');

// ─── GET /api/v1/salary-data/:roleId ─────────────────────────────────────────
const getAggregated = asyncHandler(async (req, res) => {
  const { roleId } = req.params;

  const filters = {};
  if (req.query.location)        filters.location        = req.query.location;
  if (req.query.experienceLevel) filters.experienceLevel = req.query.experienceLevel;
  if (req.query.industry)        filters.industry        = req.query.industry;

  const data = await getAggregatedSalary(roleId, filters);

  return res.status(200).json({ success: true, data });
});

// ─── GET /api/v1/salary-data/:roleId/records ─────────────────────────────────
const getRawRecords = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const records    = await listSalaryRecords(roleId);

  return res.status(200).json({ success: true, data: records, count: records.length });
});

// ─── POST /api/v1/salary-data ────────────────────────────────────────────────
const createRecord = asyncHandler(async (req, res) => {
  const adminId = req.user.uid;
  const record  = req.body;

  // Pass req.ip so it's captured in the admin audit log
  const created = await createSalaryRecord(record, adminId, req.ip);

  return res.status(201).json({ success: true, data: created });
});

module.exports = { getAggregated, getRawRecords, createRecord };








