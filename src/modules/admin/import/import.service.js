'use strict';

/**
 * import.service.js — CSV File Import Orchestrator
 *
 * This service is a thin adapter layer. Its only job is to:
 *   1. Parse the CSV buffer into rows using csvParser.util
 *   2. Validate the dataset type is supported
 *   3. Delegate to the existing adminCmsImport.service.processImport()
 *      which handles all dedup logic, database writes, and result building
 *
 * Why a separate service instead of calling processImport directly from
 * the controller?
 *   - Keeps the controller thin (HTTP concerns only)
 *   - Allows future pre-processing per dataset type (e.g. roles need
 *     jobFamilyId resolution before import, courses need category mapping)
 *   - Makes the CSV path independently testable without HTTP context
 *
 * Supported dataset types (mirrors adminCmsImport.service.SUPPORTED_TYPES):
 *   skills | roles | jobFamilies | educationLevels
 *
 * Adding a new type (e.g. courses, universities):
 *   1. Add the type to SUPPORTED_TYPES in adminCmsImport.service.js
 *   2. Add its repository to the lazy loaders in adminCmsImport.service.js
 *   3. No changes needed here or in the controller
 *
 * @module modules/admin/import/import.service
 */

const { parseCSVBuffer } = require('./csvParser.util');
const {
  processImport,
  SUPPORTED_TYPES,
} = require('../cms/import/adminCmsImport.service');
const {
  AppError,
  ErrorCodes,
} = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

/**
 * importFromCSV({ buffer, datasetType, adminId, agency })
 *
 * @param {Buffer} buffer       Raw file buffer from multer
 * @param {string} datasetType  'skills' | 'roles' | 'jobFamilies' | 'educationLevels'
 * @param {string} adminId      req.user.id — NEVER from request body
 * @param {string|null} [agency=null] req.user.agency — NEVER from request body
 *
 * @returns {Promise<{
 *   processed: number,
 *   created: number,
 *   duplicates: number,
 *   skipped: number,
 *   errors: Array<{ row: number, field: string, message: string }>,
 *   detail: Array<{ row: number, value: string, reason: string }>
 * }>}
 */
async function importFromCSV({
  buffer,
  datasetType,
  adminId,
  agency = null,
}) {
  // ── 1) Validate dataset type ─────────────────────────────────────────
  if (!SUPPORTED_TYPES.includes(datasetType)) {
    throw new AppError(
      `Unsupported datasetType "${datasetType}". Supported: ${SUPPORTED_TYPES.join(', ')}`,
      400,
      { datasetType, supported: SUPPORTED_TYPES },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // ── 2) Parse CSV buffer → rows ───────────────────────────────────────
  let rows;

  try {
    rows = parseCSVBuffer(buffer);
  } catch (err) {
    if (err.isOperational) throw err;

    throw new AppError(
      `Failed to parse CSV: ${err.message}`,
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.info('[CsvImport] CSV parsed', {
    datasetType,
    rowCount: rows.length,
    adminId,
    agency,
  });

  // ── 3) Delegate to core import processor ─────────────────────────────
  // processImport handles:
  // - sanitization
  // - normalization
  // - internal dedup
  // - database dedup
  // - bulk inserts/upserts
  // - structured result building
  const result = await processImport({
    datasetType,
    rows,
    adminId,
    agency,
  });

  // ── 4) Map to CSV-specific response shape ────────────────────────────
  return {
    processed: result.total,
    created: result.inserted,
    duplicates: result.duplicates.length,
    skipped: result.skipped,
    errors: result.errors,
    detail: result.duplicates,
  };
}

module.exports = { importFromCSV };