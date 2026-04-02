'use strict';

/**
 * salaryImport.service.js — CSV Salary Import Orchestrator
 *
 * OBSERVABILITY UPGRADE: Writes to admin_logs after every CSV import.
 *
 * Flow:
 *   1. Parse CSV buffer → rows
 *   2. Validate each row (salary ordering, numeric check)
 *   3. Normalize role names via role_aliases lookup
 *   4. Validate roleId exists in cms_roles collection
 *   5. Batch insert salary_data records (skipping duplicates)
 *   6. Write import_log entry
 *   7. Write admin_log entry
 *   8. Return summary stats
 *
 * @module modules/salaryImport/salaryImport.service
 */
const {
  parseSalaryCSVBuffer
} = require('./salaryCSVParser.util');
const salaryRepository = require('../salary/salary.repository');
const {
  validateSalaryRecord,
  logImport
} = require('../salary/salary.service');
const roleAliasRepository = require('../roleAliases/roleAlias.repository');
const {
  logAdminAction
} = require('../../utils/adminAuditLogger');
const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');
const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');

/**
 * Resolve a raw role name to a canonical roleId using role_aliases.
 * Falls back to direct name lookup in cms_roles if no alias found.
 */
async function resolveRoleId(roleName, roleCache) {
  const normalized = roleName.toLowerCase().trim();
  if (roleCache.has(normalized)) return roleCache.get(normalized);

  const canonical = await roleAliasRepository.findCanonicalRole(normalized);
  if (canonical) {
    roleCache.set(normalized, canonical.roleId);
    return canonical.roleId;
  }

  // Fallback: direct lookup in cms_roles by normalizedName
  const { data, error } = await supabase
    .from('cms_roles')
    .select('id')
    .eq('normalizedName', normalized)
    .eq('softDeleted', false)
    .limit(1)
    .maybeSingle();

  if (!error && data) {
    roleCache.set(normalized, data.id);
    return data.id;
  }

  roleCache.set(normalized, null);
  return null;
}

/**
 * Import salary records from a CSV buffer.
 *
 * @param {Buffer} buffer
 * @param {string} adminId
 * @param {string} [ipAddress]
 * @returns {Promise<object>}
 */
async function importSalariesFromCSV(buffer, adminId, ipAddress = null) {
  // ── 1. Parse CSV ──────────────────────────────────────────────────────────
  let rows;
  try {
    rows = await parseSalaryCSVBuffer(buffer);
  } catch (err) {
    if (err.isOperational) throw err;
    throw new AppError(`CSV parse failed: ${err.message}`, 400, null, ErrorCodes.VALIDATION_ERROR);
  }
  if (rows.length === 0) {
    throw new AppError('CSV file contains no data rows', 400, null, ErrorCodes.VALIDATION_ERROR);
  }
  logger.info('[SalaryImport] CSV parsed', {
    rowCount: rows.length,
    adminId
  });

  const roleCache = new Map();
  const validRecords = [];
  const errors = [];
  let skipped = 0;

  // ── 2 & 3 & 4. Validate + Normalize ──────────────────────────────────────
  for (const row of rows) {
    const rowNum = row._rowIndex;
    if (!row.role) {
      errors.push({
        row: rowNum,
        field: 'role',
        message: 'role is required'
      });
      skipped++;
      continue;
    }

    const roleId = await resolveRoleId(row.role, roleCache);
    if (!roleId) {
      errors.push({
        row: rowNum,
        field: 'role',
        message: `Role not found: "${row.role}"`
      });
      skipped++;
      continue;
    }

    if (row.minSalary === null || row.medianSalary === null || row.maxSalary === null) {
      errors.push({
        row: rowNum,
        field: 'salary',
        message: 'minSalary, medianSalary, maxSalary must be numeric'
      });
      skipped++;
      continue;
    }

    try {
      validateSalaryRecord({
        minSalary: row.minSalary,
        medianSalary: row.medianSalary,
        maxSalary: row.maxSalary
      });
    } catch (err) {
      errors.push({
        row: rowNum,
        field: 'salary',
        message: err.message
      });
      skipped++;
      continue;
    }

    validRecords.push({
      roleId,
      location: row.location,
      experienceLevel: row.experienceLevel,
      industry: row.industry,
      minSalary: row.minSalary,
      medianSalary: row.medianSalary,
      maxSalary: row.maxSalary,
      sourceType: 'CSV',
      sourceName: row.sourceName || 'csv-import',
      confidenceScore: row.confidenceScore
    });
  }

  // ── 5. Batch insert ───────────────────────────────────────────────────────
  const {
    inserted,
    duplicates
  } = await salaryRepository.batchInsert(validRecords, adminId);

  const result = {
    processed: rows.length,
    created: inserted,
    duplicates,
    skipped,
    errors
  };

  // ── 6. Write import log ───────────────────────────────────────────────────
  await logImport({
    datasetType: 'salary',
    processed: rows.length,
    created: inserted,
    failed: skipped + errors.length
  });

  // ── 7. Write admin audit log ──────────────────────────────────────────────
  await logAdminAction({
    adminId,
    action: 'CSV_IMPORT',
    entityType: 'salary_data',
    metadata: {
      processed: rows.length,
      created: inserted,
      duplicates,
      skipped,
      errorCount: errors.length
    },
    ipAddress
  });

  logger.info('[SalaryImport] Import complete', result);
  return result;
}

module.exports = {
  importSalariesFromCSV
};
