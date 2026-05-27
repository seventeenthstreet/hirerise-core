'use strict';

/**
 * src/modules/salary/salary.service.js
 *
 * Salary Data Business Logic
 *
 * Supabase-native service layer:
 * - legacy medianSalary contract removed
 * - repository schema aligned
 * - import logging fixed for Supabase
 * - stronger validation
 * - cleaner async flow
 * - production-safe logging
 *
 * @module modules/salary/salary.service
 */

const salaryRepository = require('./salary.repository');
const {
  aggregateSalaries,
} = require('./salary.aggregation');

const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');

const {
  logAdminAction,
} = require('../../utils/adminAuditLogger');

const logger = require('../../utils/logger');
const { supabase } = require('../../config/supabase');

// validateSalaryRecord and logImport now live in salary.validation.js.
// Re-imported here so existing callers (salaryApiSync.worker) are unaffected.
const {
  validateSalaryRecord,
  logImport,
  VALID_SOURCE_TYPES,
} = require('./salary.validation');



/**
 * Create a single salary record after validating it.
 *
 * @param {object} record  - Salary payload from the request body
 * @param {string} adminId - Authenticated user / admin ID
 * @param {string|null} ipAddress - Request IP for audit trail
 * @returns {Promise<object>} The inserted salary record
 */
async function createSalaryRecord(record, adminId, ipAddress = null) {
  validateSalaryRecord(record);

  const created = await salaryRepository.insertSalaryRecord(record, adminId);

  await logAdminAction({
    adminId,
    action: 'CREATE_SALARY_RECORD',
    resourceType: 'salary_data',
    resourceId: created?.id ?? null,
    metadata: { roleId: record.roleId, ipAddress },
  });

  logger.info('[SalaryService] Salary record created', {
    id: created?.id,
    roleId: record.roleId,
    adminId,
  });

  return created;
}

/**
 * Return aggregated salary intelligence for a role.
 *
 * @param {string} roleId
 * @param {object} filters - Optional { location, experienceLevel, industry }
 * @returns {Promise<object>}
 */
async function getAggregatedSalary(roleId, filters = {}) {
  if (!roleId || typeof roleId !== 'string') {
    throw new AppError(
      'roleId is required',
      400,
      { roleId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return aggregateSalaries(roleId, filters);
}

/**
 * List raw salary records for a role.
 *
 * @param {string} roleId
 * @returns {Promise<object[]>}
 */
async function listSalaryRecords(roleId) {
  if (!roleId || typeof roleId !== 'string') {
    throw new AppError(
      'roleId is required',
      400,
      { roleId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return salaryRepository.findByRoleId(roleId);
}

module.exports = {
  createSalaryRecord,
  getAggregatedSalary,
  listSalaryRecords,
  validateSalaryRecord,
  logImport,
};