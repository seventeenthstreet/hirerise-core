'use strict';

/**
 * adminCmsImport.service.js (Supabase RPC - Production Grade)
 *
 * Uses:
 *   bulk_import_dataset RPC
 *
 * Features:
 *   - Correct parameter mapping
 *   - Structured response
 *   - Safe error handling
 *   - Clean logging
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
    // ───────────────────────────────────────────
    // 🔐 VALIDATION
    // ───────────────────────────────────────────

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

    // ───────────────────────────────────────────
    // 🔒 SANITIZE INPUT
    // ───────────────────────────────────────────

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

    // ───────────────────────────────────────────
    // 🚀 RPC CALL
    // ───────────────────────────────────────────

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

    // ───────────────────────────────────────────
    // 📊 NORMALIZE RESPONSE
    // ───────────────────────────────────────────

    const result = {
      total: data?.total || 0,
      inserted: data?.inserted || 0,
      skipped: data?.skipped || 0,
      duplicates: data?.duplicates || [],
      errors: data?.errors || [],
      insertedIds: data?.insertedIds || [],
    };

    // ───────────────────────────────────────────
    // 📈 LOGGING
    // ───────────────────────────────────────────

    logger.info('[IMPORT SUCCESS]', {
      requestId,
      datasetType,
      total: result.total,
      inserted: result.inserted,
      skipped: result.skipped,
      duplicateCount: result.duplicates.length,
      errorCount: result.errors.length,
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
    insertedCount: result.inserted,
    duplicateCount: result.skipped,
    errorCount: result.errors.length,
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