'use strict';

/**
 * File: src/modules/admin/cms/import/adminCmsImport.service.js
 * Production Ready:
 * - Supabase RPC bulk import
 * - strict dataset validation
 * - row sanitization
 * - canonical + backward-compatible result normalization
 * - safe structured logging
 */

const { supabase } = require('../../../../config/supabase');
const logger = require('../../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');

// ─────────────────────────────────────────────
// 🔹 CONFIG
// ─────────────────────────────────────────────

const MAX_IMPORT_ROWS = 1000;

const SUPPORTED_TYPES = Object.freeze([
  'skills',
  'roles',
  'jobFamilies',
  'educationLevels',
  'careerDomains',
  'skillClusters',
]);

// ─────────────────────────────────────────────
// 🔹 MAIN SERVICE
// ─────────────────────────────────────────────

async function processImport({
  datasetType,
  rows,
  adminId,
  agency = null,
  requestId = null,
}) {
  const startTime = Date.now();

  try {
    if (!adminId) {
      throw new AppError(
        'Unauthorized',
        401,
        {},
        ErrorCodes.AUTH_ERROR
      );
    }

    if (!SUPPORTED_TYPES.includes(datasetType)) {
      throw new AppError(
        `Unsupported datasetType: ${datasetType}`,
        400,
        {},
        ErrorCodes.VALIDATION_ERROR
      );
    }

    if (!Array.isArray(rows)) {
      throw new AppError(
        'rows must be an array',
        400,
        {},
        ErrorCodes.VALIDATION_ERROR
      );
    }

    if (rows.length === 0) {
      return {
        rows_processed: 0,
        rows_imported: 0,
        rows_skipped: 0,
        rows_failed: 0,
        total: 0,
        inserted: 0,
        skipped: 0,
        duplicates: [],
        errors: [],
        insertedIds: [],
      };
    }

    if (rows.length > MAX_IMPORT_ROWS) {
      throw new AppError(
        `Max ${MAX_IMPORT_ROWS} rows allowed`,
        400,
        {},
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const sanitizedRows = rows.map((row, index) => {
      if (!row || typeof row !== 'object') {
        throw new AppError(
          `Invalid row format at index ${index}`,
          400,
          {},
          ErrorCodes.VALIDATION_ERROR
        );
      }

      if (!row.name || typeof row.name !== 'string') {
        throw new AppError(
          `Missing or invalid name at row ${index + 1}`,
          400,
          {},
          ErrorCodes.VALIDATION_ERROR
        );
      }

      return {
        name: row.name.trim(),
      };
    });

    const { data, error } = await supabase.rpc('bulk_import_dataset', {
      p_dataset: datasetType,
      p_rows: sanitizedRows,
      p_admin_id: adminId,
      p_agency: agency,
    });

    if (error) {
      logger.error('[IMPORT RPC ERROR]', {
        requestId,
        datasetType,
        error: error.message,
      });

      throw new AppError(
        'Database import failed',
        500,
        {},
        ErrorCodes.DB_ERROR
      );
    }

    const errors = data?.errors ?? [];
    const duplicates = data?.duplicates ?? [];

    const result = {
      // canonical fields
      rows_processed: data?.total ?? 0,
      rows_imported: data?.inserted ?? 0,
      rows_skipped: data?.skipped ?? 0,
      rows_failed: Array.isArray(errors) ? errors.length : 0,

      // backward compatibility
      total: data?.total ?? 0,
      inserted: data?.inserted ?? 0,
      skipped: data?.skipped ?? 0,
      duplicates,
      errors,
      insertedIds: data?.insertedIds ?? [],
    };

    logger.info('[IMPORT SUCCESS]', {
      requestId,
      datasetType,
      rows_processed: result.rows_processed,
      rows_imported: result.rows_imported,
      rows_skipped: result.rows_skipped,
      rows_failed: result.rows_failed,
      duplicateCount: duplicates.length,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (err) {
    logger.error('[IMPORT FAILED]', {
      requestId,
      datasetType,
      error: err.message,
    });

    throw err;
  }
}

// ─────────────────────────────────────────────
// 🔹 OPTIONAL WRAPPER (SKILLS ONLY)
// ─────────────────────────────────────────────

async function importSkills(skills, adminId, agency = null) {
  const result = await processImport({
    datasetType: 'skills',
    rows: skills,
    adminId,
    agency,
  });

  return {
    insertedCount: result.rows_imported,
    duplicateCount: result.rows_skipped,
    errorCount: result.rows_failed,
    errors: result.errors,
  };
}

// ─────────────────────────────────────────────
// 🔹 EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  processImport,
  importSkills,
  SUPPORTED_TYPES,
  MAX_IMPORT_ROWS,
};
