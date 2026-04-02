'use strict';

/**
 * adminImport.controller.js — HTTP handler factory for CSV entity imports.
 *
 * Supabase optimized version:
 * - Removes Firebase-specific uid dependency
 * - Uses Supabase JWT identity shape
 * - Hardens file validation
 * - Improves response consistency
 * - Adds safer logging metadata
 */

const { asyncHandler } = require('../../../utils/helpers');
const { importEntityCSV } = require('./adminImport.service');
const { getImportStatus } = require('./importDependency.service');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

const ALLOWED_MIMES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

function getFileExtension(filename = '') {
  const match = filename.toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : '';
}

function getAuthenticatedAdmin(req) {
  const adminId =
    req.user?.id ||          // Supabase standard
    req.user?.sub ||         // JWT fallback
    req.auth?.user?.id ||    // middleware fallback
    null;

  if (!adminId) {
    throw new AppError(
      'Authenticated admin identity missing.',
      401,
      null,
      ErrorCodes.AUTH_ERROR
    );
  }

  return {
    adminId,
    agency:
      req.user?.agency ||
      req.user?.user_metadata?.agency ||
      req.user?.app_metadata?.agency ||
      null,
  };
}

/**
 * Factory for entity CSV import handlers
 */
function adminImportController(entityType) {
  return asyncHandler(async (req, res) => {
    // ───────────────────────────────────────────────────────────
    // Validate uploaded file
    // ───────────────────────────────────────────────────────────
    if (!req.file?.buffer) {
      throw new AppError(
        'No CSV file uploaded. Send a file in multipart/form-data field "file".',
        400,
        null,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const filename = req.file.originalname || 'unknown.csv';
    const extension = getFileExtension(filename);
    const mimeType = req.file.mimetype || '';

    const isValidCSV =
      ALLOWED_MIMES.has(mimeType) || extension === '.csv';

    if (!isValidCSV) {
      throw new AppError(
        `CSV file required. Received: ${mimeType || 'unknown'}`,
        400,
        {
          filename,
          receivedMime: mimeType,
        },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // ───────────────────────────────────────────────────────────
    // Extract Supabase admin identity
    // ───────────────────────────────────────────────────────────
    const { adminId, agency } = getAuthenticatedAdmin(req);

    logger.info('[AdminImport] Import request received', {
      entityType,
      filename,
      sizeBytes: req.file.size || req.file.buffer.length,
      adminId,
      agency,
    });

    // ───────────────────────────────────────────────────────────
    // Delegate import to service
    // ───────────────────────────────────────────────────────────
    const result = await importEntityCSV({
      buffer: req.file.buffer,
      entityType,
      adminId,
      agency,
    });

    const hasPartialFailure =
      result.failed > 0 && (result.created > 0 || result.updated > 0);

    // ───────────────────────────────────────────────────────────
    // Frontend-compatible response envelope
    // ───────────────────────────────────────────────────────────
    return res.status(hasPartialFailure ? 207 : 200).json({
      success: true,
      created: result.created || 0,
      updated: result.updated || 0,
      skipped: result.skipped || 0,
      failed: result.failed || 0,
      errors: result.failed || 0,
      total: result.total || 0,
      rows: result.rows || [],
      importedAt: result.importedAt || new Date().toISOString(),
      nextStep: result.nextStep ?? null,
      meta: {
        entityType,
        filename,
        importedByAdminId: adminId,
        sourceAgency: agency,
      },
    });
  });
}

/**
 * GET /admin/import/status
 *
 * Returns import workflow step state
 */
const importStatusController = asyncHandler(async (_req, res) => {
  const steps = await getImportStatus();

  return res.status(200).json({
    success: true,
    data: steps || [],
  });
});

module.exports = {
  adminImportController,
  importStatusController,
};