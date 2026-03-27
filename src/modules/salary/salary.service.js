'use strict';

/**
 * salary.service.js — Salary Data Business Logic
 *
 * OBSERVABILITY UPGRADE: Manual salary entry now writes to admin_logs.
 *
 * Responsibilities:
 *   - Validate salary records before insertion
 *   - Enforce salary ordering constraint: minSalary < medianSalary < maxSalary
 *   - Coordinate with repository for all writes
 *   - Log import activity to import_logs collection
 *   - Log manual admin actions to admin_logs collection
 *
 * @module modules/salary/salary.service
 */
const salaryRepository = require('./salary.repository');
const {
  aggregateSalaries
} = require('./salaryAggregation.service');
const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');
const {
  logAdminAction
} = require('../../utils/adminAuditLogger');
const logger = require('../../utils/logger');
const {
  db
} = require('../../config/supabase');
const IMPORT_LOGS_COLLECTION = 'import_logs';
const VALID_SOURCE_TYPES = ['ADMIN', 'CSV', 'API', 'SCRAPER'];

/**
 * Validate a salary record object.
 * Throws AppError on invalid input.
 * Used by: salary.service, salaryImport.service, salaryApiSync.worker
 *
 * @param {object} record
 */
function validateSalaryRecord(record) {
  const {
    minSalary,
    medianSalary,
    maxSalary,
    sourceType
  } = record;
  if (typeof minSalary !== 'number' || isNaN(minSalary) || typeof medianSalary !== 'number' || isNaN(medianSalary) || typeof maxSalary !== 'number' || isNaN(maxSalary)) {
    throw new AppError('minSalary, medianSalary, and maxSalary must be numeric values', 400, {
      minSalary,
      medianSalary,
      maxSalary
    }, ErrorCodes.VALIDATION_ERROR);
  }
  if (minSalary < 0 || medianSalary < 0 || maxSalary < 0) {
    throw new AppError('Salary values cannot be negative', 400, {
      minSalary,
      medianSalary,
      maxSalary
    }, ErrorCodes.VALIDATION_ERROR);
  }
  if (!(minSalary < medianSalary && medianSalary < maxSalary)) {
    throw new AppError('Salary values must satisfy: minSalary < medianSalary < maxSalary', 400, {
      minSalary,
      medianSalary,
      maxSalary
    }, ErrorCodes.VALIDATION_ERROR);
  }
  if (sourceType && !VALID_SOURCE_TYPES.includes(sourceType)) {
    throw new AppError(`Invalid sourceType. Must be one of: ${VALID_SOURCE_TYPES.join(', ')}`, 400, {
      sourceType
    }, ErrorCodes.VALIDATION_ERROR);
  }
}

/**
 * Create a single salary record (ADMIN manual entry).
 * Writes to admin_logs after successful insert.
 *
 * @param {object} record
 * @param {string} adminId
 * @param {string} [ipAddress]
 * @returns {Promise<object>}
 */
async function createSalaryRecord(record, adminId, ipAddress = null) {
  validateSalaryRecord(record);
  const payload = {
    roleId: record.roleId,
    location: record.location || '',
    experienceLevel: record.experienceLevel || '',
    industry: record.industry || '',
    minSalary: record.minSalary,
    medianSalary: record.medianSalary,
    maxSalary: record.maxSalary,
    sourceType: record.sourceType || 'ADMIN',
    sourceName: record.sourceName || 'admin-manual',
    confidenceScore: record.confidenceScore ?? 1.0
  };
  const created = await salaryRepository.insertSalaryRecord(payload, adminId);
  logger.info('[SalaryService] Salary record created', {
    id: created.id,
    roleId: created.roleId,
    source: created.sourceType
  });

  // Audit log — fire-and-forget
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
      medianSalary: created.medianSalary,
      maxSalary: created.maxSalary,
      sourceType: created.sourceType
    },
    ipAddress
  });
  return created;
}

/**
 * Get aggregated salary intelligence for a roleId.
 * Results are served from cache when available (see salaryAggregation.service.js).
 */
async function getAggregatedSalary(roleId, filters = {}) {
  return await aggregateSalaries(roleId, filters);
}

/**
 * List salary records for a roleId (raw, non-aggregated).
 */
async function listSalaryRecords(roleId) {
  if (!roleId) throw new AppError('roleId is required', 400, null, ErrorCodes.VALIDATION_ERROR);
  return await salaryRepository.findByRoleId(roleId);
}

/**
 * Write an import log entry to Firestore.
 */
async function logImport({
  datasetType,
  processed,
  created,
  failed
}) {
  if (!db) return;
  try {
    await supabase.from(IMPORT_LOGS_COLLECTION).insert({
      datasetType,
      recordsProcessed: processed,
      recordsInserted: created,
      recordsFailed: failed,
      timestamp: new Date()
    });
  } catch (err) {
    logger.warn('[SalaryService] Failed to write import log', {
      err: err.message
    });
  }
}
module.exports = {
  createSalaryRecord,
  getAggregatedSalary,
  listSalaryRecords,
  validateSalaryRecord,
  logImport
};