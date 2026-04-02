'use strict';

/**
 * graphAdmin.routes.js
 */

const express = require('express');
const multer  = require('multer');
const { param, query } = require('express-validator');

const { validate } = require('../../../middleware/requestValidator');
const { AppError } = require('../../../middleware/errorHandler');
const logger       = require('../../../utils/logger');

const ctrl = require('./graphAdmin.controller');

const {
  GRAPH_DATASET_TYPES,
} = require('./graph.constants');

if (!Array.isArray(GRAPH_DATASET_TYPES) || !GRAPH_DATASET_TYPES.length) {
  GRAPH_DATASET_TYPES = [
    'roles',
    'skills',
    'role_skills',
    'role_transitions',
    'skill_relationships',
    'role_education',
    'role_salary_market',
    'role_market_demand',
  ];
}

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Multer Config (Hardened)
// ─────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();

    const isCSV =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/csv' ||
      file.mimetype === 'text/plain' ||
      name.endsWith('.csv');

    if (!isCSV) {
      return cb(
        new AppError(
          `CSV file required. Received: ${file.mimetype}`,
          400,
          null,
          'INVALID_FILE'
        )
      );
    }

    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────
// Multer Error Handler
// ─────────────────────────────────────────────────────────────

function multerErr(err, _req, _res, next) {
  if (err instanceof multer.MulterError) {
    return next(
      new AppError(
        err.code === 'LIMIT_FILE_SIZE'
          ? 'File too large (max 10MB)'
          : err.message,
        400,
        null,
        'INVALID_FILE'
      )
    );
  }
  next(err);
}

// ─────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────

const datasetTypeParam = param('datasetType')
  .isIn(GRAPH_DATASET_TYPES)
  .withMessage(
    `datasetType must be one of: ${GRAPH_DATASET_TYPES.join(', ')}`
  );

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

router.post(
  '/import/:datasetType',
  upload.single('file'),
  multerErr,
  validate([datasetTypeParam]),
  (req, res, next) => {
    logger.info('[GraphRoutes] Import request received', {
      datasetType: req.params.datasetType,
      adminId: req.user?.id,
      fileSize: req.file?.size,
    });
    next();
  },
  ctrl.importDataset
);

router.post(
  '/preview/:datasetType',
  upload.single('file'),
  multerErr,
  validate([datasetTypeParam]),
  (req, res, next) => {
    logger.info('[GraphRoutes] Preview request received', {
      datasetType: req.params.datasetType,
      adminId: req.user?.id,
    });
    next();
  },
  ctrl.previewDataset
);

router.get('/metrics', ctrl.graphMetrics);

router.get('/validate', ctrl.validateGraph);

router.get('/dataset-statuses', ctrl.datasetStatuses);

router.get('/health', ctrl.graphHealth);

router.get('/alerts', ctrl.graphAlerts);

router.get('/stats', ctrl.graphStats);

router.get(
  '/import-logs',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: 200 })
      .toInt(),
  ]),
  ctrl.importLogs
);

// ─────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────

module.exports = router;