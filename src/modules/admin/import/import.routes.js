'use strict';

const express = require('express');
const multer = require('multer');

const {
  adminImportController,
} = require('./adminImport.controller');

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const router = express.Router();

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext =
      (file.originalname || '')
        .toLowerCase()
        .match(/\.[^.]+$/)?.[0] || '';

    const isCSV =
      CSV_MIME_TYPES.has(file.mimetype) ||
      ext === '.csv';

    if (!isCSV) {
      return cb(
        new AppError(
          'CSV file required.',
          400,
          null,
          ErrorCodes.VALIDATION_ERROR
        )
      );
    }

    cb(null, true);
  },
});

router.post(
  '/csv/:datasetType',
  upload.single('file'),
  (req, _res, next) => {
    req.entityType = req.params.datasetType;
    next();
  },
  (req, res, next) =>
    adminImportController(req.params.datasetType)(req, res, next)
);

module.exports = router;