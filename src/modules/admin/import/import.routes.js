'use strict';

/**
 * import.routes.js — CSV Import Route Definitions
 *
 * Mounted in server.js as:
 *   app.use(
 *     `${API_PREFIX}/admin/cms/import/csv`,
 *     authenticate,
 *     requireAdmin,
 *     require('./modules/admin/import/import.routes')
 *   );
 *
 * Routes:
 *   POST /api/v1/admin/cms/import/csv/:datasetType
 *
 * Supported datasetType values:
 *   skills | roles | jobFamilies | educationLevels
 *
 * Adding new dataset types later (e.g. courses, universities):
 *   1. Add the type to SUPPORTED_TYPES in adminCmsImport.service.js
 *   2. Add its repository lazy-loader in adminCmsImport.service.js
 *   3. This route file needs NO changes — it accepts any valid datasetType
 *      and the service layer validates it.
 *
 * Multer config:
 *   - memoryStorage (consistent with onboarding and resume upload routes)
 *   - 5MB limit (sufficient for ~50k skill rows at typical CSV field widths)
 *   - fileFilter blocks non-CSV MIME types before multer stores the buffer
 *     (controller also validates — defense in depth)
 *
 * @module modules/admin/import/import.routes
 */

const express  = require('express');
const multer   = require('multer');
const { param } = require('express-validator');
const { validate }   = require('../../../middleware/requestValidator');
const { importCSV }  = require('./import.controller');
const { AppError }   = require('../../../middleware/errorHandler');

const router = express.Router();

// ── Multer — memory storage, 5MB limit, CSV-only filter ──────────────────────

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB — enforced before fileFilter runs
  },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    const isCSVMime = CSV_MIME_TYPES.has(file.mimetype);
    const isCSVExt  = ext === '.csv';

    if (isCSVMime || isCSVExt) {
      return cb(null, true);
    }

    // Reject — multer will call next(err) with this
    cb(new AppError(
      `CSV file required. Received: "${file.mimetype}" (${file.originalname})`,
      400,
      { received: file.mimetype, filename: file.originalname },
      'INVALID_FILE'
    ));
  },
});

// ── Multer error handler ──────────────────────────────────────────────────────
// Converts multer-specific errors (file size, unexpected field) into
// the standard AppError envelope before they reach the central errorHandler.
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(
        'File too large. Maximum size is 5MB.',
        400,
        { limit: '5MB' },
        'INVALID_FILE'
      ));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError(
        'Unexpected field. Upload the CSV in a field named "file".',
        400, null, 'INVALID_FILE'
      ));
    }
    return next(new AppError(err.message, 400, null, 'INVALID_FILE'));
  }
  next(err); // pass other errors through
}

// ── Route ─────────────────────────────────────────────────────────────────────

const VALID_DATASET_TYPES = ['skills', 'roles', 'jobFamilies', 'educationLevels'];

/**
 * POST /api/v1/admin/cms/import/csv/:datasetType
 *
 * Multipart form-data body:
 *   file  (required)  — CSV file
 *
 * URL param:
 *   datasetType  — one of: skills | roles | jobFamilies | educationLevels
 *
 * Example:
 *   POST /api/v1/admin/cms/import/csv/skills
 */
router.post(
  '/:datasetType',
  upload.single('file'),
  handleMulterError,
  validate([
    param('datasetType')
      .isIn(VALID_DATASET_TYPES)
      .withMessage(`datasetType must be one of: ${VALID_DATASET_TYPES.join(', ')}`),
  ]),
  importCSV
);

module.exports = router;








