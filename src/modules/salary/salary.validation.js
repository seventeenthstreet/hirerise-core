'use strict';

/**
 * @file src/modules/salary/salary.validation.js
 *
 * Salary domain validation utilities and import log writer.
 * Pure validation functions + a single lightweight Supabase write.
 *
 * Extracted from salary.service.js (Phase D, Group A fix #4) so that
 * salaryImport.service and salaryApiSync.worker can consume these
 * without importing the full salary domain service.
 *
 * salary.service.js re-exports these for backwards compatibility.
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const VALID_SOURCE_TYPES = ['ADMIN', 'CSV', 'API', 'SCRAPER'];
const IMPORT_LOGS_TABLE = 'import_logs';

/**
 * Validate a salary record's business rules.
 * Throws AppError on any violation.
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
      'confidenceScore must be a number between 0 and 1',
      400,
      { confidenceScore },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

/**
 * Append-only import event log.
 * Non-fatal — errors are warned, not thrown.
 *
 * @param {object} params
 * @param {string} params.datasetType
 * @param {number} [params.processed]
 * @param {number} [params.created]
 * @param {number} [params.failed]
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
        dataset_type:       datasetType,
        records_processed:  processed,
        records_inserted:   created,
        records_failed:     failed,
      });

    if (error) {
      logger.warn('[salary.validation] Failed to write import log', {
        error: error.message,
        datasetType,
      });
    }
  } catch (err) {
    logger.warn('[salary.validation] Import log insert failed', {
      error: err.message,
      datasetType,
    });
  }
}

module.exports = {
  validateSalaryRecord,
  logImport,
  VALID_SOURCE_TYPES,
};