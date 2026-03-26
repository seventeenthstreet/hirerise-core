'use strict';

const { asyncHandler }   = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
let importGraphDataset, validateGraphIntegrity, getGraphMetrics, getImportLogs,
    getDatasetStatuses, getGraphHealth, getGraphAlerts, getCareerGraphStats, GRAPH_DATASET_TYPES;
try {
  ({
    importGraphDataset, validateGraphIntegrity, getGraphMetrics, getImportLogs,
    getDatasetStatuses, getGraphHealth, getGraphAlerts, getCareerGraphStats, GRAPH_DATASET_TYPES,
  } = require('./graphImport.service'));
} catch (e) {
  const stub = async () => { throw new Error('Graph service unavailable: ' + e.message); };
  importGraphDataset = validateGraphIntegrity = getGraphMetrics = getImportLogs =
    getDatasetStatuses = getGraphHealth = getGraphAlerts = getCareerGraphStats = stub;
  GRAPH_DATASET_TYPES = [
    'roles', 'skills', 'role_skills', 'role_transitions',
    'skill_relationships', 'role_education', 'role_salary_market', 'role_market_demand',
  ];
}
const logger = require('../../../utils/logger');

const ALLOWED_MIMES = new Set(['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel']);

function requireCSV(req) {
  if (!req.file) throw new AppError('No file uploaded. Send a CSV in the "file" field.', 400, null, ErrorCodes.VALIDATION_ERROR);
  const ext = (req.file.originalname || '').toLowerCase().endsWith('.csv');
  if (!ALLOWED_MIMES.has(req.file.mimetype) && !ext) {
    throw new AppError(`CSV file required. Received: ${req.file.mimetype}`, 400, null, 'INVALID_FILE');
  }
}

// POST /admin/graph/import/:datasetType  — full import with optional mode=append|replace
const importDataset = asyncHandler(async (req, res) => {
  requireCSV(req);
  const { datasetType } = req.params;
  const mode = ['append', 'replace'].includes(req.body?.mode) ? req.body.mode : 'append';

  if (!GRAPH_DATASET_TYPES.includes(datasetType)) {
    throw new AppError(`Unknown dataset type "${datasetType}". Supported: ${GRAPH_DATASET_TYPES.join(', ')}`, 400, null, ErrorCodes.VALIDATION_ERROR);
  }

  const result = await importGraphDataset({
    buffer:      req.file.buffer,
    datasetType,
    adminId:     req.user.uid,
    preview:     false,
    mode,
  });

  logger.info('[GraphAdmin] Import completed', {
    datasetType, mode, processed: result.processed, imported: result.imported,
    errors: result.errorCount, adminId: req.user.uid,
  });

  const status = result.errorCount > 0 && result.imported > 0 ? 207 : 200;
  res.status(status).json({ success: true, data: result });
});

// POST /admin/graph/preview/:datasetType — dry-run validation, returns all error categories
const previewDataset = asyncHandler(async (req, res) => {
  requireCSV(req);
  const { datasetType } = req.params;
  const mode = ['append', 'replace'].includes(req.body?.mode) ? req.body.mode : 'append';

  if (!GRAPH_DATASET_TYPES.includes(datasetType)) {
    throw new AppError(`Unknown dataset type "${datasetType}"`, 400, null, ErrorCodes.VALIDATION_ERROR);
  }

  const result = await importGraphDataset({
    buffer:      req.file.buffer,
    datasetType,
    adminId:     req.user.uid,
    preview:     true,
    mode,
  });

  res.json({ success: true, data: result });
});

// GET /admin/graph/metrics
const graphMetrics = asyncHandler(async (_req, res) => {
  const metrics = await getGraphMetrics();
  res.json({ success: true, data: metrics });
});

// GET /admin/graph/validate
const validateGraph = asyncHandler(async (_req, res) => {
  const report = await validateGraphIntegrity();
  res.json({ success: true, data: report });
});

// GET /admin/graph/import-logs
const importLogs = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const logs  = await getImportLogs({ limit });
  res.json({ success: true, data: { logs, count: logs.length } });
});

// GET /admin/graph/dataset-statuses — Admin Data Import Center overview
const datasetStatuses = asyncHandler(async (_req, res) => {
  const statuses = await getDatasetStatuses();
  res.json({ success: true, data: statuses });
});

// GET /admin/graph/health — coverage percentages per dataset
const graphHealth = asyncHandler(async (_req, res) => {
  try {
    const health = await getGraphHealth();
    res.json({ success: true, data: health });
  } catch (err) {
    logger.error('[GraphHealth] getGraphHealth failed', { error: err.message, stack: err.stack });
    throw err;
  }
});

// GET /admin/graph/alerts — automatic graph issue detection
const graphAlerts = asyncHandler(async (_req, res) => {
  const alerts = await getGraphAlerts();
  res.json({ success: true, data: alerts });
});

// GET /admin/graph/stats — career graph structural statistics
const graphStats = asyncHandler(async (_req, res) => {
  const stats = await getCareerGraphStats();
  res.json({ success: true, data: stats });
});

module.exports = { importDataset, previewDataset, graphMetrics, validateGraph, importLogs, datasetStatuses, graphHealth, graphAlerts, graphStats };








