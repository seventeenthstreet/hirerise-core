'use strict';

/**
 * graphAdmin.controller.js
 * Production Ready:
 * - CSV import
 * - Redis cache invalidation
 * - cache warming
 * - circular dependency removed
 */

const { asyncHandler } = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');
const { redis } = require('../../../config/redisClient');
const { setCache } = require('../../../utils/cache.util');
const supabase = require('../../../config/supabase');
const { GRAPH_DATASET_TYPES } = require('./graph.constants');

let importGraphDataset;
let validateGraphIntegrity;
let getGraphMetrics;
let getImportLogs;
let getDatasetStatuses;
let getGraphHealth;
let getGraphAlerts;
let getCareerGraphStats;

try {
  ({
    importGraphDataset,
    validateGraphIntegrity,
    getGraphMetrics,
    getImportLogs,
    getDatasetStatuses,
    getGraphHealth,
    getGraphAlerts,
    getCareerGraphStats,
  } = require('./graphImport.service'));
} catch (e) {
  const stub = async () => {
    throw new Error(`Graph service unavailable: ${e.message}`);
  };

  importGraphDataset = stub;
  validateGraphIntegrity = stub;
  getGraphMetrics = stub;
  getImportLogs = stub;
  getDatasetStatuses = stub;
  getGraphHealth = stub;
  getGraphAlerts = stub;
  getCareerGraphStats = stub;
}

const ALLOWED_MIMES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

const MAX_FILE_SIZE = 5 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function requireCSV(req) {
  if (!req.file) {
    throw new AppError(
      'No file uploaded.',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (req.file.size > MAX_FILE_SIZE) {
    throw new AppError(
      'File too large (max 5MB)',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const name = (req.file.originalname || '').toLowerCase();
  const isCSV = name.endsWith('.csv');

  if (!ALLOWED_MIMES.has(req.file.mimetype) && !isCSV) {
    throw new AppError(
      `CSV required. Received: ${req.file.mimetype}`,
      400,
      null,
      'INVALID_FILE'
    );
  }
}

function validateDatasetType(datasetType) {
  if (!GRAPH_DATASET_TYPES.includes(datasetType)) {
    throw new AppError(
      `Invalid dataset "${datasetType}"`,
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

function getMode(body) {
  return ['append', 'replace'].includes(body?.mode)
    ? body.mode
    : 'append';
}

// ─────────────────────────────────────────────────────────────
// Cache Helpers
// ─────────────────────────────────────────────────────────────

async function invalidateGraphCache(datasetType) {
  try {
    const keys = new Set();

    if (
      ['roles', 'role_transitions', 'role_skills'].includes(datasetType)
    ) {
      keys.add('graph:career');
    }

    if (
      ['skills', 'skill_relationships', 'role_skills'].includes(datasetType)
    ) {
      keys.add('graph:skills');
    }

    if (!keys.size) return [];

    await Promise.all([...keys].map((key) => redis.del(key)));

    logger.info('[GraphCache] Invalidated', {
      datasetType,
      keys: [...keys],
    });

    return [...keys];
  } catch (err) {
    logger.warn('[GraphCache] Invalidation failed', {
      datasetType,
      error: err.message,
    });
    return [];
  }
}

async function warmGraphCache(keys) {
  try {
    const tasks = [];

    if (keys.includes('graph:career')) {
      tasks.push((async () => {
        const [{ data: roles = [] }, { data: transitions = [] }] =
          await Promise.all([
            supabase.from('roles').select('*').limit(5000),
            supabase.from('role_transitions').select('*').limit(5000),
          ]);

        const payload = {
          roles: roles.filter((r) => r.name || r.role_name),
          transitions,
          node_count: roles.length,
          edge_count: transitions.length,
        };

        await setCache('graph:career', payload, 300);
      })());
    }

    if (keys.includes('graph:skills')) {
      tasks.push((async () => {
        const [{ data: skills = [] }, { data: relationships = [] }] =
          await Promise.all([
            supabase.from('skills').select('*').limit(5000),
            supabase.from('skill_relationships').select('*').limit(5000),
          ]);

        const payload = {
          skills: skills.filter((s) => s.name || s.skill_name),
          relationships,
          node_count: skills.length,
          edge_count: relationships.length,
        };

        await setCache('graph:skills', payload, 300);
      })());
    }

    await Promise.all(tasks);

    logger.info('[GraphCache] Warmed', { keys });
  } catch (err) {
    logger.warn('[GraphCache] Warming failed', {
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────

const importDataset = asyncHandler(async (req, res) => {
  const start = Date.now();

  requireCSV(req);

  const { datasetType } = req.params;
  validateDatasetType(datasetType);

  const mode = getMode(req.body);

  let result;
  let warmedKeys = [];

  try {
    result = await importGraphDataset({
      buffer: req.file.buffer,
      datasetType,
      adminId: req.user.id,
      preview: false,
      mode,
    });

    const invalidatedKeys = await invalidateGraphCache(datasetType);

    if (invalidatedKeys.length) {
      await warmGraphCache(invalidatedKeys);
      warmedKeys = invalidatedKeys;
    }
  } catch (err) {
    logger.error('[GraphImport] Failed', {
      datasetType,
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }

  const duration = Date.now() - start;
  const throughput =
    Math.round((result?.imported || 0) / (duration / 1000)) || 0;

  const status =
    result?.errorCount > 0 && result?.imported > 0 ? 207 : 200;

  res.status(status).json({
    success: true,
    meta: {
      duration_ms: duration,
      throughput_rows_per_sec: throughput,
      cache_warmed: warmedKeys,
    },
    data: result,
  });
});

const previewDataset = asyncHandler(async (req, res) => {
  requireCSV(req);

  const { datasetType } = req.params;
  validateDatasetType(datasetType);

  const mode = getMode(req.body);

  const result = await importGraphDataset({
    buffer: req.file.buffer,
    datasetType,
    adminId: req.user.id,
    preview: true,
    mode,
  });

  res.json({ success: true, data: result });
});

const graphMetrics = asyncHandler(async (_req, res) => {
  const metrics = await getGraphMetrics();
  res.json({ success: true, data: metrics });
});

const validateGraph = asyncHandler(async (_req, res) => {
  const report = await validateGraphIntegrity();
  res.json({ success: true, data: report });
});

const importLogs = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const logs = await getImportLogs({ limit });

  res.json({
    success: true,
    data: { logs, count: logs.length },
  });
});

const datasetStatuses = asyncHandler(async (_req, res) => {
  const statuses = await getDatasetStatuses();
  res.json({ success: true, data: statuses });
});

const graphHealth = asyncHandler(async (_req, res) => {
  const health = await getGraphHealth();
  res.json({ success: true, data: health });
});

const graphAlerts = asyncHandler(async (_req, res) => {
  const alerts = await getGraphAlerts();
  res.json({ success: true, data: alerts });
});

const graphStats = asyncHandler(async (_req, res) => {
  const stats = await getCareerGraphStats();
  res.json({ success: true, data: stats });
});

module.exports = {
  importDataset,
  previewDataset,
  graphMetrics,
  validateGraph,
  importLogs,
  datasetStatuses,
  graphHealth,
  graphAlerts,
  graphStats,
};