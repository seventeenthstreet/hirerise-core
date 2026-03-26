'use strict';

/**
 * adminImport.controller.js — HTTP handler factory for CSV entity imports.
 *
 * Returns an Express request handler that:
 *   1. Validates the uploaded file exists and is a CSV
 *   2. Extracts admin identity from JWT (never from body)
 *   3. Delegates to adminImport.service
 *   4. Returns the ImportResult envelope the frontend expects:
 *      { success, created, updated, failed, rows, total, importedAt }
 *
 * @module modules/admin/import/adminImport.controller
 */

const { asyncHandler }     = require('../../../utils/helpers');
const { importEntityCSV }  = require('./adminImport.service');
const { getImportStatus }  = require('./importDependency.service');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

const ALLOWED_MIMES = new Set([
  'text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel',
]);

/**
 * adminImportController(entityType)
 *
 * Factory that returns a bound asyncHandler for the given entity type.
 *
 * @param {string} entityType   Internal entity key passed to the service
 *   e.g. 'skills', 'roles', 'jobFamilies', 'educationLevels', 'salaryBenchmarks'
 */
function adminImportController(entityType) {
  return asyncHandler(async (req, res) => {

    // ── File presence & MIME guard ─────────────────────────────────────────
    if (!req.file) {
      throw new AppError(
        'No file uploaded. Send a CSV in the "file" field of a multipart/form-data request.',
        400, null, ErrorCodes.VALIDATION_ERROR
      );
    }

    const ext = (req.file.originalname || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    if (!ALLOWED_MIMES.has(req.file.mimetype) && ext !== '.csv') {
      throw new AppError(
        `CSV file required. Received: ${req.file.mimetype || 'unknown'}`,
        400,
        { received: req.file.mimetype, filename: req.file.originalname },
        'INVALID_FILE'
      );
    }

    // ── Identity always from JWT ───────────────────────────────────────────
    const adminId = req.user.uid;
    const agency  = req.user.agency ?? null;

    logger.info('[AdminImport] Import request received', {
      entityType,
      filename:  req.file.originalname,
      sizeBytes: req.file.size,
      adminId,
      agency,
    });

    // ── Delegate to service ────────────────────────────────────────────────
    const result = await importEntityCSV({
      buffer:     req.file.buffer,
      entityType,
      adminId,
      agency,
    });

    // ── Response envelope (matches frontend ImportResult type) ─────────────
    // { success, created, updated, failed, total, rows, importedAt }
    return res.status(result.failed > 0 && result.created > 0 ? 207 : 200).json({
      success:    true,
      created:    result.created,
      updated:    result.updated,
      skipped:    result.skipped,
      errors:     result.failed,
      failed:     result.failed,
      total:      result.total,
      rows:       result.rows,
      importedAt: result.importedAt,
      nextStep:   result.nextStep ?? null,
      meta: {
        entityType,
        filename:          req.file.originalname,
        importedByAdminId: adminId,
        sourceAgency:      agency,
      },
    });
  });
}

/**
 * importStatusController
 * GET /admin/import/status
 *
 * Returns the current state of all ordered import steps so the frontend
 * can render the step indicator and lock/unlock each step accordingly.
 */
const importStatusController = asyncHandler(async (_req, res) => {
  const steps = await getImportStatus();
  return res.status(200).json({ success: true, data: steps });
});

module.exports = { adminImportController, importStatusController };








