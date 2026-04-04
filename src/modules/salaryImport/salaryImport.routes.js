'use strict';

/**
 * src/modules/salaryImport/salaryImport.routes.js
 *
 * Production-ready CSV salary bulk import route.
 *
 * Supabase migration note:
 * Route layer is database-agnostic. Main migration concern is ensuring
 * request context, async flow, and upload validation are robust for the
 * Supabase-backed service layer.
 *
 * POST /api/v1/admin/import/salaries
 * Content-Type: multipart/form-data
 * Field: file
 *
 * @module modules/salaryImport/salaryImport.routes
 */

const express = require('express');
const multer = require('multer');

const { importSalariesFromCSV } = require('./salaryImport.service');
const { asyncHandler } = require('../../utils/helpers');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');

const router = express.Router();

const MAX_CSV_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

/**
 * Validate CSV upload files.
 * Keeps API behavior unchanged while improving safety.
 */
function csvFileFilter(req, file, cb) {
  const fileName = String(file?.originalname || '').toLowerCase();
  const mimeType = String(file?.mimetype || '').toLowerCase();

  const isCsv = CSV_MIME_TYPES.has(mimeType) || fileName.endsWith('.csv');

  if (!isCsv) {
    return cb(
      new AppError(
        'Only CSV files are accepted',
        400,
        {
          mimeType,
          fileName,
        },
        ErrorCodes.VALIDATION_ERROR
      )
    );
  }

  return cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CSV_SIZE_BYTES,
    files: 1,
  },
  fileFilter: csvFileFilter,
});

/**
 * Multer-specific error normalization.
 */
function normalizeUploadError(error) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new AppError(
        'CSV file exceeds maximum allowed size of 10MB',
        400,
        { maxSizeBytes: MAX_CSV_SIZE_BYTES },
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  return error;
}

router.post(
  '/',
  (req, res, next) => {
    upload.single('file')(req, res, (error) => {
      if (error) {
        return next(normalizeUploadError(error));
      }
      return next();
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file?.buffer?.length) {
      throw new AppError(
        'No CSV file uploaded. Attach file with field name "file"',
        400,
        null,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const adminId = req.user?.uid;

    if (!adminId) {
      throw new AppError(
        'Authenticated admin context missing',
        401,
        null,
        ErrorCodes.AUTHENTICATION_ERROR
      );
    }

    // Preserve existing audit behavior for Supabase admin_logs writes.
    const result = await importSalariesFromCSV(
      req.file.buffer,
      adminId,
      req.ip
    );

    const hasErrors = Array.isArray(result?.errors) && result.errors.length > 0;
    const statusCode = hasErrors ? 207 : 201;

    return res.status(statusCode).json({
      success: true,
      data: result,
    });
  })
);

module.exports = router;