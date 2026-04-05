'use strict';

/**
 * src/routes/admin/adminMetrics.routes.js
 *
 * FULLY PRODUCTION SAFE
 * Supabase-native + cache-optimized + singleton-safe
 */

const { Router } = require('express');

const { getClient, withRetry } = require('../../config/supabase');
const { adminMetricsService } = require('../../services/admin/adminMetrics.service');
const { adminMetricsAggregator } = require('../../workers/adminMetrics.aggregator');
const { verifySuperAdmin } = require('../../middleware/verifyAdmin.middleware');
const logger = require('../../utils/logger');

const router = Router();

const VALID_PERIODS = new Set(['7d', '30d', '90d', '1y']);
const CONTENT_COUNTS_TTL = 60 * 1000;

// ─────────────────────────────────────────────
// In-memory cache
// ─────────────────────────────────────────────
let contentCountsCache = null;
let contentCountsCachedAt = 0;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getDb() {
  return getClient();
}

async function safeCount(tableName) {
  const db = getDb();

  try {
    const { count, error } = await withRetry(() =>
      db.from(tableName).select('*', {
        count: 'exact',
        head: true,
      })
    );

    if (error) throw error;

    return count ?? 0;
  } catch (err) {
    logger.warn('[AdminMetrics] exact count failed, using fallback', {
      tableName,
      error: err?.message,
    });

    try {
      const { data, error } = await withRetry(() =>
        db.from(tableName).select('id').limit(10000)
      );

      if (error) throw error;

      return (data ?? []).length;
    } catch (fallbackErr) {
      logger.error('[AdminMetrics] count fallback failed', {
        tableName,
        error: fallbackErr?.message,
      });

      return 0;
    }
  }
}

async function getLatestImportDate(tableName) {
  const db = getDb();

  const { data, error } = await withRetry(() =>
    db
      .from(tableName)
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
  );

  if (error) {
    logger.warn('[AdminMetrics] latest import lookup failed', {
      tableName,
      error: error.message,
    });
    return null;
  }

  return data?.[0]?.created_at ?? null;
}

async function getContentCounts() {
  const now = Date.now();

  if (
    contentCountsCache &&
    now - contentCountsCachedAt < CONTENT_COUNTS_TTL
  ) {
    return contentCountsCache;
  }

  const [
    totalSkills,
    totalRoles,
    totalJobFamilies,
    totalEducationLevels,
    totalSalaryRecords,
    totalUsers,
  ] = await Promise.all([
    safeCount('cms_skills'),
    safeCount('cms_roles'),
    safeCount('cms_job_families'),
    safeCount('cms_education_levels'),
    safeCount('cms_salary_benchmarks'),
    safeCount('users'),
  ]);

  const importDates = (
    await Promise.all([
      getLatestImportDate('cms_skills'),
      getLatestImportDate('cms_roles'),
      getLatestImportDate('cms_job_families'),
      getLatestImportDate('cms_education_levels'),
      getLatestImportDate('cms_salary_benchmarks'),
    ])
  ).filter(Boolean);

  const lastImportAt = importDates.length
    ? importDates.sort().at(-1)
    : null;

  const result = {
    totalSkills,
    totalRoles,
    totalJobFamilies,
    totalEducationLevels,
    totalSalaryRecords,
    totalUsers,
    lastImportAt,
  };

  contentCountsCache = result;
  contentCountsCachedAt = now;

  return result;
}

function validateQueryParams(req) {
  const { period, startDate, endDate } = req.query;

  if (startDate || endDate) {
    if (!startDate || !endDate) {
      return {
        params: {},
        error: 'Both startDate and endDate are required (YYYY-MM-DD)',
      };
    }

    const startMs = Date.parse(startDate);
    const endMs = Date.parse(endDate);

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return {
        params: {},
        error: 'Invalid date format. Use YYYY-MM-DD.',
      };
    }

    if (endMs < startMs) {
      return {
        params: {},
        error: 'endDate must be >= startDate.',
      };
    }

    const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24);

    if (diffDays > 365) {
      return {
        params: {},
        error: 'Date range cannot exceed 365 days.',
      };
    }

    return { params: { startDate, endDate } };
  }

  const resolvedPeriod = period ?? '30d';

  if (!VALID_PERIODS.has(resolvedPeriod)) {
    return {
      params: {},
      error: `Invalid period. Valid options: ${[
        ...VALID_PERIODS,
      ].join(', ')}`,
    };
  }

  return { params: { period: resolvedPeriod } };
}

// ─────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { params, error } = validateQueryParams(req);

  if (error) {
    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: error,
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const [contentCounts, aiMetrics] = await Promise.all([
      getContentCounts(),
      adminMetricsService.getMetrics(params),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        ...aiMetrics,
        totalSkills: contentCounts.totalSkills,
        totalRoles: contentCounts.totalRoles,
        totalJobFamilies: contentCounts.totalJobFamilies,
        totalEducationLevels: contentCounts.totalEducationLevels,
        totalSalaryRecords: contentCounts.totalSalaryRecords,
        totalUsers: contentCounts.totalUsers,
        activeUsers30d: aiMetrics.activeUsers ?? 0,
        lastImportAt: contentCounts.lastImportAt,
      },
      meta: {
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('[AdminMetrics] getMetrics failed', {
      message: err?.message,
    });

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Failed to compute metrics.',
      timestamp: new Date().toISOString(),
    });
  }
});

// ─────────────────────────────────────────────
// GET /aggregated
// ─────────────────────────────────────────────
router.get('/aggregated', async (req, res) => {
  const { params, error } = validateQueryParams(req);

  if (error) {
    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: error,
    });
  }

  try {
    const data = await adminMetricsService.getAggregatedMetrics(params);

    return res.status(200).json({
      success: true,
      data,
      meta: {
        generatedAt: new Date().toISOString(),
        note: 'Data from pre-computed daily aggregates.',
      },
    });
  } catch (err) {
    logger.error('[AdminMetrics] getAggregatedMetrics failed', {
      message: err?.message,
    });

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Failed to fetch aggregated metrics.',
    });
  }
});

// ─────────────────────────────────────────────
// POST /aggregate
// ─────────────────────────────────────────────
router.post('/aggregate', verifySuperAdmin, async (req, res) => {
  const dateStr = req.body?.date ?? undefined;

  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'date must be YYYY-MM-DD format.',
    });
  }

  try {
    const result = await adminMetricsAggregator.runJob(dateStr);

    // refresh stale cache after manual aggregation
    contentCountsCache = null;
    contentCountsCachedAt = 0;

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        triggeredAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('[AdminMetrics] manual aggregation failed', {
      message: err?.message,
    });

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Aggregation job failed.',
    });
  }
});

module.exports = router;