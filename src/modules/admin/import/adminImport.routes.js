'use strict';

/**
 * adminImport.routes.js
 *
 * Fully Supabase-native CSV import routes
 * Flat route structure for admin dataset ingestion
 */

const express = require('express');
const multer = require('multer');

const {
  adminImportController,
  importStatusController,
} = require('./adminImport.controller');

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const router = express.Router();

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

const SUPPORTED_IMPORT_ROUTES = [
  'career-domains',
  'job-families',
  'skill-clusters',
  'skills',
  'roles',
  'education-levels',
  'salary-benchmarks',
  'skill-demand',
  'role-skills',
];

function isValidCSV(file) {
  const ext =
    (file.originalname || '')
      .toLowerCase()
      .match(/\.[^.]+$/)?.[0] || '';

  return CSV_MIME_TYPES.has(file.mimetype) || ext === '.csv';
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (isValidCSV(file)) {
      return cb(null, true);
    }

    return cb(
      new AppError(
        `CSV file required. Received "${file.mimetype}"`,
        400,
        {
          filename: file.originalname,
          mimeType: file.mimetype,
        },
        ErrorCodes.VALIDATION_ERROR
      )
    );
  },
});

function handleMulterError(err, _req, _res, next) {
  if (!(err instanceof multer.MulterError)) {
    return next(err);
  }

  const errorMap = {
    LIMIT_FILE_SIZE: 'File too large. Maximum size is 10 MB.',
    LIMIT_UNEXPECTED_FILE:
      'Unexpected field. Upload CSV using field name "file".',
  };

  return next(
    new AppError(
      errorMap[err.code] || err.message,
      400,
      { code: err.code },
      ErrorCodes.VALIDATION_ERROR
    )
  );
}

const fileMiddleware = [
  upload.single('file'),
  handleMulterError,
];

// ─────────────────────────────────────────────────────────────
// Workflow status route
// ─────────────────────────────────────────────────────────────
router.get('/status', importStatusController);

// ─────────────────────────────────────────────────────────────
// Dynamically register all entity import routes
// ─────────────────────────────────────────────────────────────
SUPPORTED_IMPORT_ROUTES.forEach((entityType) => {
  router.post(
    `/${entityType}`,
    fileMiddleware,
    adminImportController(entityType)
  );
});

module.exports = router;