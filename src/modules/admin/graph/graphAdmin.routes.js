'use strict';

/**
 * graphAdmin.routes.js
 *
 * Mounted: app.use(`\${API_PREFIX}/admin/graph`, authenticate, requireAdmin, ...)
 *
 * POST  /import/:datasetType          — Import CSV (body: mode=append|replace)
 * POST  /preview/:datasetType         — Dry-run validation
 * GET   /metrics                      — Graph collection counts
 * GET   /validate                     — Integrity checker
 * GET   /dataset-statuses             — Dataset status per collection
 * GET   /health                       — Coverage % per dataset (Graph Health Panel)
 * GET   /alerts                       — Automatic issue detection (Graph Alerts)
 * GET   /stats                        — Career graph structural stats (path depth etc)
 * GET   /import-logs                  — Import history
 */

const express = require('express');
const multer  = require('multer');
const { param, query } = require('express-validator');
const { validate }     = require('../../../middleware/requestValidator');
const { AppError }     = require('../../../middleware/errorHandler');
const ctrl             = require('./graphAdmin.controller');
let GRAPH_DATASET_TYPES;
try {
  GRAPH_DATASET_TYPES = require('./graphImport.service').GRAPH_DATASET_TYPES;
} catch (e) {
  GRAPH_DATASET_TYPES = [];
}
if (!Array.isArray(GRAPH_DATASET_TYPES) || GRAPH_DATASET_TYPES.length === 0) {
  GRAPH_DATASET_TYPES = [
    'roles', 'skills', 'role_skills', 'role_transitions',
    'skill_relationships', 'role_education', 'role_salary_market', 'role_market_demand',
  ];
}

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isCSV = file.mimetype.includes('csv') || file.mimetype === 'text/plain' || file.originalname.endsWith('.csv');
    isCSV ? cb(null, true) : cb(new AppError('CSV file required', 400, null, 'INVALID_FILE'));
  },
});

function multerErr(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10MB)' : err.message, 400, null, 'INVALID_FILE'));
  }
  next(err);
}

const datasetTypeParam = param('datasetType')
  .isIn(GRAPH_DATASET_TYPES)
  .withMessage(`datasetType must be one of: ${GRAPH_DATASET_TYPES.join(', ')}`);

router.post('/import/:datasetType',
  upload.single('file'), multerErr,
  validate([datasetTypeParam]),
  ctrl.importDataset
);

router.post('/preview/:datasetType',
  upload.single('file'), multerErr,
  validate([datasetTypeParam]),
  ctrl.previewDataset
);

router.get('/metrics',          ctrl.graphMetrics);
router.get('/validate',         ctrl.validateGraph);
router.get('/dataset-statuses', ctrl.datasetStatuses);
router.get('/health',          ctrl.graphHealth);
router.get('/alerts',          ctrl.graphAlerts);
router.get('/stats',           ctrl.graphStats);
router.get('/import-logs',
  validate([query('limit').optional().isInt({ min: 1, max: 200 }).toInt()]),
  ctrl.importLogs
);

module.exports = router;








