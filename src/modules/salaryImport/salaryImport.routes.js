'use strict';

/**
 * salaryImport.routes.js — CSV Salary Bulk Import Route
 *
 * OBSERVABILITY UPGRADE: passes req.ip to importSalariesFromCSV
 * so it is captured in the admin audit log.
 *
 * POST /api/v1/admin/import/salaries
 * Content-Type: multipart/form-data, field: file (CSV, max 10MB)
 *
 * @module modules/salaryImport/salaryImport.routes
 */

const express  = require('express');
const multer   = require('multer');
const { importSalariesFromCSV } = require('./salaryImport.service');
const { asyncHandler }          = require('../../utils/helpers');
const { AppError, ErrorCodes }  = require('../../middleware/errorHandler');

const router = express.Router();

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    if (CSV_MIME_TYPES.has(file.mimetype) || ext.endsWith('.csv')) {
      return cb(null, true);
    }
    cb(new AppError('Only CSV files are accepted', 400, null, ErrorCodes.VALIDATION_ERROR));
  },
});

router.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new AppError('No CSV file uploaded. Attach file with field name "file"', 400, null, ErrorCodes.VALIDATION_ERROR);
    }

    const adminId = req.user.uid;

    // Pass req.ip for audit log capture
    const result = await importSalariesFromCSV(req.file.buffer, adminId, req.ip);

    const hasErrors = result.errors && result.errors.length > 0;
    const status    = hasErrors ? 207 : 201;

    return res.status(status).json({ success: true, data: result });
  })
);

module.exports = router;








