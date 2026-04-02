'use strict';

/**
 * adminMetrics.routes.js — FULLY FIXED (Production Safe)
 */

const { Router } = require('express');
const { supabase } = require('../../config/supabase'); // ✅ FIXED
const { adminMetricsService } = require('../../services/admin/adminMetrics.service');
const { adminMetricsAggregator } = require('../../workers/adminMetrics.aggregator');
const { verifySuperAdmin } = require('../../middleware/verifyAdmin.middleware');

// ── Content counts ─────────────────────────────────────────

let _contentCountsCache = null;
let _contentCountsCachedAt = 0;
const CONTENT_COUNTS_TTL = 60 * 1000;

async function getContentCounts() {
  const now = Date.now();

  if (_contentCountsCache && now - _contentCountsCachedAt < CONTENT_COUNTS_TTL) {
    return _contentCountsCache;
  }

  async function safeCount(tableName) {
    try {
      const { count, error } = await supabase
        .from(tableName)
        .select('*', { count: 'exact', head: true });

      if (error) throw error;
      return count ?? 0;

    } catch (err) {
      // fallback (safe)
      try {
        const { data } = await supabase.from(tableName).select('id').limit(10000);
        return (data ?? []).length;
      } catch {
        return 0;
      }
    }
  }

  const [
    totalSkills,
    totalRoles,
    totalJobFamilies,
    totalEducationLevels,
    totalSalaryRecords,
    totalUsers
  ] = await Promise.all([
    safeCount('cms_skills'),
    safeCount('cms_roles'),
    safeCount('cms_job_families'),
    safeCount('cms_education_levels'),
    safeCount('cms_salary_benchmarks'),
    safeCount('users')
  ]);

  // ── Last import dates (FIXED snake_case) ──────────────────

  const queries = [
    'cms_skills',
    'cms_roles',
    'cms_job_families',
    'cms_education_levels',
    'cms_salary_benchmarks'
  ].map(table =>
    supabase
      .from(table)
      .select('created_at') // ✅ FIXED
      .order('created_at', { ascending: false })
      .limit(1)
  );

  const results = await Promise.all(queries);

  const importDates = results
    .map(res => {
      if (res.error) return null;
      return res.data?.[0]?.created_at ?? null;
    })
    .filter(Boolean);

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
    lastImportAt
  };

  _contentCountsCache = result;
  _contentCountsCachedAt = now;

  return result;
}

// ─────────────────────────────────────────────

const router = Router();
const VALID_PERIODS = new Set(['7d', '30d', '90d', '1y']);

function validateQueryParams(req) {
  const { period, startDate, endDate } = req.query;

  if (startDate || endDate) {
    if (!startDate || !endDate) {
      return { params: {}, error: 'Both startDate and endDate are required (YYYY-MM-DD)' };
    }

    const startMs = Date.parse(startDate);
    const endMs = Date.parse(endDate);

    if (isNaN(startMs) || isNaN(endMs)) {
      return { params: {}, error: 'Invalid date format. Use YYYY-MM-DD.' };
    }

    if (endMs < startMs) {
      return { params: {}, error: 'endDate must be >= startDate.' };
    }

    if ((endMs - startMs) / (1000 * 60 * 60 * 24) > 365) {
      return { params: {}, error: 'Date range cannot exceed 365 days.' };
    }

    return { params: { startDate, endDate } };
  }

  const resolvedPeriod = period ?? '30d';

  if (!VALID_PERIODS.has(resolvedPeriod)) {
    return {
      params: {},
      error: `Invalid period. Valid options: ${[...VALID_PERIODS].join(', ')}`
    };
  }

  return { params: { period: resolvedPeriod } };
}

// ─────────────────────────────────────────────
// MAIN ROUTE
// ─────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { params, error } = validateQueryParams(req);

  if (error) {
    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: error,
      timestamp: new Date().toISOString()
    });
  }

  try {
    const [contentCounts, aiMetrics] = await Promise.all([
      getContentCounts(),
      adminMetricsService.getMetrics(params)
    ]);

    const data = {
      ...aiMetrics,
      totalSkills: contentCounts.totalSkills,
      totalRoles: contentCounts.totalRoles,
      totalJobFamilies: contentCounts.totalJobFamilies,
      totalEducationLevels: contentCounts.totalEducationLevels,
      totalSalaryRecords: contentCounts.totalSalaryRecords,
      totalUsers: contentCounts.totalUsers,
      activeUsers30d: aiMetrics.activeUsers ?? 0,
      lastImportAt: contentCounts.lastImportAt
    };

    return res.status(200).json({
      success: true,
      data,
      meta: { generatedAt: new Date().toISOString() }
    });

  } catch (err) {
    console.error('[AdminMetrics] getMetrics failed:', err?.message);

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Failed to compute metrics.',
      timestamp: new Date().toISOString()
    });
  }
});

// ─────────────────────────────────────────────
// AGGREGATED
// ─────────────────────────────────────────────

router.get('/aggregated', async (req, res) => {
  const { params, error } = validateQueryParams(req);

  if (error) {
    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: error
    });
  }

  try {
    const data = await adminMetricsService.getAggregatedMetrics(params);

    return res.status(200).json({
      success: true,
      data,
      meta: {
        generatedAt: new Date().toISOString(),
        note: 'Data from pre-computed daily aggregates.'
      }
    });

  } catch (err) {
    console.error('[AdminMetrics] getAggregatedMetrics failed:', err?.message);

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Failed to fetch aggregated metrics.'
    });
  }
});

// ─────────────────────────────────────────────
// MANUAL AGGREGATION
// ─────────────────────────────────────────────

router.post('/aggregate', verifySuperAdmin, async (req, res) => {
  const dateStr = req.body?.date ?? undefined;

  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'date must be YYYY-MM-DD format.'
    });
  }

  try {
    const result = await adminMetricsAggregator.runJob(dateStr);

    return res.status(200).json({
      success: true,
      data: result,
      meta: { triggeredAt: new Date().toISOString() }
    });

  } catch (err) {
    console.error('[AdminMetrics] Manual aggregation failed:', err?.message);

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Aggregation job failed.'
    });
  }
});

module.exports = router;