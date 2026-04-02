'use strict';

/**
 * salary.controller.js — Fully Optimized
 *
 * ✅ Strong validation
 * ✅ Input sanitization
 * ✅ Limits protection
 * ✅ Better logging
 */

const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const salaryService = require('../services/salary.service');
const SalaryIntelligenceService = require('../services/salary.intelligence.service');
const logger = require('../utils/logger');

const salaryIntelligenceService = new SalaryIntelligenceService();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function ok(res, data) {
  return res.status(200).json({
    success: true,
    data,
    meta: { requestedAt: new Date().toISOString() },
  });
}

function requireField(value, field) {
  if (value === undefined || value === null || value === '') {
    throw new AppError(
      `${field} is required`,
      400,
      { field },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

function toNumber(val, field) {
  const num = Number(val);
  if (Number.isNaN(num)) {
    throw new AppError(
      `${field} must be a number`,
      400,
      { field },
      ErrorCodes.VALIDATION_ERROR
    );
  }
  return num;
}

function validateExperience(exp) {
  if (exp < 0 || exp > 50) {
    throw new AppError(
      'experienceYears must be between 0 and 50',
      400,
      { exp },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

function sanitizeString(val) {
  if (!val) return null;
  return String(val).trim().slice(0, 100);
}

function parseRoleIds(roleIds) {
  if (!roleIds) return [];

  let ids = [];

  if (Array.isArray(roleIds)) {
    ids = roleIds;
  } else if (typeof roleIds === 'string') {
    ids = roleIds.split(',').map(r => r.trim());
  }

  // 🔥 Limit protection (max 10 roles)
  if (ids.length > 10) {
    throw new AppError(
      'Maximum 10 roleIds allowed',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return ids.filter(Boolean);
}

// ─────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────

exports.getBenchmark = asyncHandler(async (req, res) => {
  const { roleId, experienceYears, location } = req.body;

  requireField(roleId, 'roleId');
  requireField(experienceYears, 'experienceYears');

  const exp = toNumber(experienceYears, 'experienceYears');
  validateExperience(exp);

  const safeLocation = sanitizeString(location);

  logger.info('[Salary] Benchmark request', {
    roleId,
    exp,
    location: safeLocation,
  });

  const result = await salaryService.computeBenchmark({
    roleId,
    experienceYears: exp,
    location: safeLocation,
  });

  return ok(res, result);
});


exports.getIntelligence = asyncHandler(async (req, res) => {
  const { roleId, experienceYears, location, industry, currentSalary } = req.body;

  requireField(roleId, 'roleId');
  requireField(experienceYears, 'experienceYears');

  const exp = toNumber(experienceYears, 'experienceYears');
  validateExperience(exp);

  const salary = currentSalary
    ? toNumber(currentSalary, 'currentSalary')
    : null;

  const safeLocation = sanitizeString(location);
  const safeIndustry = sanitizeString(industry);

  logger.info('[Salary] Intelligence request', {
    roleId,
    exp,
    location: safeLocation,
  });

  const result = await salaryIntelligenceService.generateIntelligence({
    roleId,
    experienceYears: exp,
    location: safeLocation,
    industry: safeIndustry,
    currentSalary: salary,
  });

  return ok(res, result);
});


exports.getSalaryBands = asyncHandler(async (req, res) => {
  const { roleId } = req.params;

  requireField(roleId, 'roleId');

  logger.info('[Salary] Bands request', { roleId });

  const result = await salaryService.getAllBandsForRole(roleId);

  return ok(res, result);
});


exports.compareSalaries = asyncHandler(async (req, res) => {
  const { roleIds, experienceYears } = req.query;

  const parsedRoleIds = parseRoleIds(roleIds);

  if (!parsedRoleIds.length) {
    throw new AppError(
      'roleIds is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const exp = experienceYears
    ? toNumber(experienceYears, 'experienceYears')
    : null;

  if (exp !== null) validateExperience(exp);

  logger.info('[Salary] Compare request', {
    roleIds: parsedRoleIds,
    exp,
  });

  const result = await salaryService.compareRoles({
    roleIds: parsedRoleIds,
    experienceYears: exp,
  });

  return ok(res, result);
});