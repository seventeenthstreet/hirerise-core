'use strict';

/**
 * salary.controller.js
 *
 * CHANGES (remediation sprint):
 *   FIX-5: Removed ALL self-contained try/catch blocks that were:
 *           - Swallowing every error (including 404s, 500s) and returning 400
 *           - Using { success: false, message: error.message } (no errorCode, no timestamp)
 *           - Bypassing the central errorHandler entirely
 *          Each handler is now wrapped with asyncHandler() so any thrown AppError or
 *          unexpected error propagates to errorHandler and returns the standard envelope.
 *   FIX-7: mapExperienceToLevel in salary.intelligence.service.js expanded to L1-L6
 *          (see that file). This controller now correctly propagates the AppError thrown
 *          when a band is not found, instead of swallowing it as a generic 400.
 *   FIX-10: Corrected service method names to match salary.service.js exports:
 *           - getBenchmark    → computeBenchmark
 *           - getSalaryBands  → getAllBandsForRole
 *           - compareSalaries → compareRoles
 */

const { asyncHandler }           = require('../utils/helpers');
const { AppError, ErrorCodes }   = require('../middleware/errorHandler');
const salaryService              = require('../services/salary.service');
const SalaryIntelligenceService  = require('../services/salary.intelligence.service');

const salaryIntelligenceService = new SalaryIntelligenceService();

/**
 * POST /api/v1/salary/benchmark
 */
exports.getBenchmark = asyncHandler(async (req, res) => {
  const { roleId, experienceYears, location } = req.body;

  // FIX-10: was salaryService.getBenchmark (not a function)
  const result = await salaryService.computeBenchmark({ roleId, experienceYears, location });

  return res.status(200).json({
    success: true,
    data: result,
    meta: { requestedAt: new Date().toISOString() },
  });
});


/**
 * POST /api/v1/salary/intelligence
 */
exports.getIntelligence = asyncHandler(async (req, res) => {
  const { roleId, experienceYears, location, industry, currentSalary } = req.body;

  const result = await salaryIntelligenceService.generateIntelligence({
    roleId,
    experienceYears,
    location,
    industry,
    currentSalary,
  });

  return res.status(200).json({
    success: true,
    data: result,
    meta: { requestedAt: new Date().toISOString() },
  });
});


/**
 * GET /api/v1/salary/bands/:roleId
 */
exports.getSalaryBands = asyncHandler(async (req, res) => {
  const { roleId } = req.params;

  // FIX-10: was salaryService.getSalaryBands (not a function)
  // getAllBandsForRole throws AppError itself if not found — no null check needed
  const result = await salaryService.getAllBandsForRole(roleId);

  return res.status(200).json({
    success: true,
    data: result,
    meta: { requestedAt: new Date().toISOString() },
  });
});


/**
 * GET /api/v1/salary/compare
 */
exports.compareSalaries = asyncHandler(async (req, res) => {
  const { roleIds, experienceYears } = req.query;

  // FIX-10: was salaryService.compareSalaries (not a function)
  const result = await salaryService.compareRoles({ roleIds, experienceYears });

  return res.status(200).json({
    success: true,
    data: result,
    meta: { requestedAt: new Date().toISOString() },
  });
});