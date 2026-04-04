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
} = require('./salaryAggregation.service');

const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');

const {
  logAdminAction,
} = require('../../utils/adminAuditLogger');

const logger = require('../../utils/logger');
const { supabase } = require('../../config/supabase');

const IMPORT_LOGS_TABLE = 'import_logs';
const VALID_SOURCE_TYPES = ['ADMIN', 'CSV', 'API', 'SCRAPER'];

/**
 * Validate a salary record object.
 *
 * Current DB contract:
 * - minSalary
 * - maxSalary
 *
 * @param {object} record
 */
function validateSalaryRecord(record = {}) {
  const {
    roleId,
    minSalary,
    maxSalary,
    sourceType,
    confidenceScore,
  } = record;

  if (!roleId || typeof roleId !== 'string') {
    throw new AppError(
      'roleId is required',
      400,
      { roleId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (
    typeof minSalary !== 'number' ||
    Number.isNaN(minSalary) ||
    typeof maxSalary !== 'number' ||
    Number.isNaN(maxSalary)
  ) {
    throw new AppError(
      'minSalary and maxSalary must be numeric values',
      400,
      { minSalary, maxSalary },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (minSalary < 0 || maxSalary < 0) {
    throw new AppError(
      'Salary values cannot be negative',
      400,
      { minSalary, maxSalary },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (minSalary >= maxSalary) {
    throw new AppError(
      'Salary values must satisfy: minSalary < maxSalary',
      400,
      { minSalary, maxSalary },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (sourceType && !VALID_SOURCE_TYPES.includes(sourceType)) {
    throw new AppError(
      `Invalid sourceType. Must be one of: ${VALID_SOURCE_TYPES.join(', ')}`,
      400,
      { sourceType },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (
    confidenceScore != null &&
    (typeof confidenceScore !== 'number' ||
      Number.isNaN(confidenceScore) ||
      confidenceScore < 0 ||
      confidenceScore > 1)
  ) {
    throw new AppError(
      'confidenceScore must be between 0 and 1',
      400,
      { confidenceScore },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

/**
 * Create a single salary record (ADMIN manual entry).
 *
 * @param {object} record
 * @param {string} adminId
 * @param {string|null} ipAddress
 * @returns {Promise<object>}
 */
async function createSalaryRecord(record, adminId, ipAddress = null) {
  validateSalaryRecord(record);

  const payload = {
    roleId: record.roleId,
    location: record.location || null,
    experienceLevel: record.experienceLevel || null,
    industry: record.industry || null,
    minSalary: record.minSalary,
    maxSalary: record.maxSalary,
    sourceType: record.sourceType || 'ADMIN',
    sourceName: record.sourceName || 'admin-manual',
    confidenceScore: record.confidenceScore ?? 1.0,
  };

  const created = await salaryRepository.insertSalaryRecord(payload, adminId);

  logger.info('[SalaryService] Salary record created', {
    id: created.id,
    roleId: created.roleId,
    sourceType: created.sourceType,
  });

  await logAdminAction({
    adminId,
    action: 'MANUAL_SALARY_ENTRY',
    entityType: 'salary_data',
    entityId: created.id,
    metadata: {
      roleId: created.roleId,
      experienceLevel: created.experienceLevel,
      location: created.location,
      minSalary: created.minSalary,
      maxSalary: created.maxSalary,
      sourceType: created.sourceType,
    },
    ipAddress,
  });

  return created;
}

/**
 * Get aggregated salary intelligence for a role.
 *
 * @param {string} roleId
 * @param {object} filters
 * @returns {Promise<object>}
 */
async function getAggregatedSalary(roleId, filters = {}) {
  return aggregateSalaries(roleId, filters);
}

/**
 * List raw salary records for a role.
 *
 * @param {string} roleId
 * @returns {Promise<object[]>}
 */
async function listSalaryRecords(roleId) {
  if (!roleId) {
    throw new AppError(
      'roleId is required',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return salaryRepository.findByRoleId(roleId);
}

/**
 * Write import log entry to Supabase.
 *
 * Non-blocking operational logging path.
 */
async function logImport({
  datasetType,
  processed = 0,
  created = 0,
  failed = 0,
}) {
  try {
    const { error } = await supabase
      .from(IMPORT_LOGS_TABLE)
      .insert({
        dataset_type: datasetType,
        records_processed: processed,
        records_inserted: created,
        records_failed: failed,
      });

    if (error) {
      logger.warn('[SalaryService] Failed to write import log', {
        error: error.message,
        datasetType,
      });
    }
  } catch (err) {
    logger.warn('[SalaryService] Import log insert failed', {
      error: err.message,
      datasetType,
    });
  }
}

module.exports = {
  createSalaryRecord,
  getAggregatedSalary,
  listSalaryRecords,
  validateSalaryRecord,
  logImport,
};