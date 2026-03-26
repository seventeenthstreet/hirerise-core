'use strict';

/**
 * import.controller.js — CSV Import HTTP Handler
 *
 * Handles all HTTP concerns for the CSV import endpoint:
 *   - Validates the uploaded file is present and is a CSV
 *   - Extracts admin identity from JWT (never from request body)
 *   - Delegates to importService
 *   - Returns standard response envelope
 *
 * Security contract:
 *   adminId  = req.user.uid      — always from JWT
 *   agency   = req.user.agency   — always from JWT
 *   Neither field can come from the CSV file or request body.
 *
 * @module modules/admin/import/import.controller
 */

const { asyncHandler }   = require('../../../utils/helpers');
const { importFromCSV }  = require('./import.service');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

/**
 * POST /api/v1/admin/cms/import/csv/:datasetType
 *
 * Multipart form-data:
 *   file        — CSV file (field name: "file")
 *   (datasetType comes from URL param, not body — prevents content-type confusion)
 */
const importCSV = asyncHandler(async (req, res) => {

  // ── File validation ────────────────────────────────────────────────────
  if (!req.file) {
    throw new AppError(
      'No file uploaded. Send a CSV file in the "file" field of a multipart/form-data request.',
      400, null, ErrorCodes.VALIDATION_ERROR
    );
  }

  // Guard against MIME spoofing — check both mimetype and original filename
  const allowedMimeTypes = new Set([
    'text/csv',
    'text/plain',                // Some OS/browsers send .csv as text/plain
    'application/csv',
    'application/vnd.ms-excel',  // Windows sends .csv as this
  ]);
  const allowedExtensions = new Set(['.csv']);
  const ext = (req.file.originalname || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';

  if (!allowedMimeTypes.has(req.file.mimetype) && !allowedExtensions.has(ext)) {
    throw new AppError(
      'CSV file required. Received: ' + (req.file.mimetype || 'unknown type'),
      400,
      { received: req.file.mimetype, filename: req.file.originalname },
      'INVALID_FILE'
    );
  }

  // ── Identity from JWT only ─────────────────────────────────────────────
  const adminId    = req.user.uid;
  const agency     = req.user.agency ?? null;
  const { datasetType } = req.params;

  logger.info('[CsvImport] Import request received', {
    datasetType,
    filename:  req.file.originalname,
    sizeBytes: req.file.size,
    adminId,
    agency,
  });

  // ── Delegate to service ────────────────────────────────────────────────
  const result = await importFromCSV({
    buffer: req.file.buffer,
    datasetType,
    adminId,
    agency,
  });

  // ── Response ──────────────────────────────────────────────────────────
  // Use 207 Multi-Status if some rows were created and some were skipped.
  // Use 201 if all rows were created cleanly.
  // Use 200 if 0 rows were created (all duplicates/errors) — not a failure.
  const statusCode = result.created > 0 && (result.duplicates > 0 || result.skipped > 0)
    ? 207
    : result.created > 0
      ? 201
      : 200;

  return res.status(statusCode).json({
    success: true,
    data: {
      processed:  result.processed,
      created:    result.created,
      duplicates: result.duplicates,
      skipped:    result.skipped,
    },
    ...(result.errors.length  > 0 && { errors:  result.errors  }),
    ...(result.detail.length  > 0 && { detail:  result.detail  }),
    meta: {
      datasetType,
      filename:          req.file.originalname,
      importedByAdminId: adminId,
      sourceAgency:      agency,
      importedAt:        new Date().toISOString(),
    },
  });
});

module.exports = { importCSV };








