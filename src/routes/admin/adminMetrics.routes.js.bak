'use strict';

/**
 * adminMetrics.routes.js
 * Converted from adminMetrics.routes.ts
 */

const { Router }                 = require('express');
const { adminMetricsService }    = require('../../services/admin/adminMetrics.service');
const { adminMetricsAggregator } = require('../../workers/adminMetrics.aggregator');
const { verifySuperAdmin }       = require('../../middleware/verifyAdmin.middleware');

// ── Content counts ─────────────────────────────────────────────────────────────
// Fetches document counts for the five CMS collections shown on the dashboard.
// Uses Firestore COUNT aggregation queries (one round-trip per collection).
// Results are cached for 60 s to avoid hammering Firestore on every page load.

let _contentCountsCache   = null;
let _contentCountsCachedAt = 0;
const CONTENT_COUNTS_TTL  = 60 * 1000; // 60 seconds

async function getContentCounts() {
  const now = Date.now();
  if (_contentCountsCache && now - _contentCountsCachedAt < CONTENT_COUNTS_TTL) {
    return _contentCountsCache;
  }

  const db = require('../../config/supabase').db;

  // Safe count helper — tries COUNT aggregation first (firebase-admin ≥11, Firestore native mode).
  // Falls back to a full .get() if aggregation isn't supported (emulator, Datastore mode).
  async function safeCount(collectionName) {
    try {
      const snap = await db.collection(collectionName).count().get();
      return snap.data().count;
    } catch (_) {
      const snap = await db.collection(collectionName).get();
      return snap.size;
    }
  }

  // Run all six counts in parallel
  const [totalSkills, totalRoles, totalJobFamilies, totalEducationLevels, totalSalaryRecords, totalUsers] =
    await Promise.all([
      safeCount('cms_skills'),
      safeCount('cms_roles'),
      safeCount('cms_job_families'),
      safeCount('cms_education_levels'),
      safeCount('cms_salary_benchmarks'),
      safeCount('users'),
    ]);

  // Find the most recent createdAt across all five CMS collections
  const [lastSkill, lastRole, lastJobFamily, lastEdu, lastSalary] = await Promise.all([
    db.collection('cms_skills').orderBy('createdAt', 'desc').limit(1).get(),
    db.collection('cms_roles').orderBy('createdAt', 'desc').limit(1).get(),
    db.collection('cms_job_families').orderBy('createdAt', 'desc').limit(1).get(),
    db.collection('cms_education_levels').orderBy('createdAt', 'desc').limit(1).get(),
    db.collection('cms_salary_benchmarks').orderBy('createdAt', 'desc').limit(1).get(),
  ]);

  const importDates = [lastSkill, lastRole, lastJobFamily, lastEdu, lastSalary]
    .map(snap => snap.docs[0]?.data()?.createdAt ?? null)
    .filter(Boolean);

  const lastImportAt = importDates.length > 0
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

  _contentCountsCache   = result;
  _contentCountsCachedAt = now;
  return result;
}

const router = Router();

const VALID_PERIODS = new Set(['7d', '30d', '90d', '1y']);

function validateQueryParams(req) {
  const { period, startDate, endDate } = req.query;
  if (startDate || endDate) {
    if (!startDate || !endDate) return { params: {}, error: 'Both startDate and endDate are required (YYYY-MM-DD)' };
    const startMs = Date.parse(startDate), endMs = Date.parse(endDate);
    if (isNaN(startMs) || isNaN(endMs)) return { params: {}, error: 'Invalid date format. Use YYYY-MM-DD.' };
    if (endMs < startMs) return { params: {}, error: 'endDate must be >= startDate.' };
    if ((endMs - startMs) / (1000 * 60 * 60 * 24) > 365) return { params: {}, error: 'Date range cannot exceed 365 days.' };
    return { params: { startDate, endDate } };
  }
  const resolvedPeriod = period ?? '30d';
  if (!VALID_PERIODS.has(resolvedPeriod)) return { params: {}, error: `Invalid period. Valid options: ${[...VALID_PERIODS].join(', ')}` };
  return { params: { period: resolvedPeriod } };
}

router.get('/', async (req, res) => {
  const { params, error } = validateQueryParams(req);
  if (error) return res.status(400).json({ success: false, errorCode: 'VALIDATION_ERROR', message: error, timestamp: new Date().toISOString() });
  try {
    // Fetch content counts and AI/billing metrics in parallel
    const [contentCounts, aiMetrics] = await Promise.all([
      getContentCounts(),
      adminMetricsService.getMetrics(params),
    ]);

    // Merge: content counts (dashboard stat cards) + AI billing data (metrics deep-dive)
    // The frontend AdminMetrics type reads: totalSkills, totalRoles, totalJobFamilies,
    // totalEducationLevels, totalSalaryRecords, totalUsers, activeUsers30d, lastImportAt
    const data = {
      ...aiMetrics,
      totalSkills:          contentCounts.totalSkills,
      totalRoles:           contentCounts.totalRoles,
      totalJobFamilies:     contentCounts.totalJobFamilies,
      totalEducationLevels: contentCounts.totalEducationLevels,
      totalSalaryRecords:   contentCounts.totalSalaryRecords,
      totalUsers:           contentCounts.totalUsers,
      activeUsers30d:       aiMetrics.activeUsers ?? 0,
      lastImportAt:         contentCounts.lastImportAt,
    };

    return res.status(200).json({ success: true, data, meta: { generatedAt: new Date().toISOString() } });
  } catch (err) {
    console.error('[AdminMetrics] getMetrics failed:', err?.message);
    return res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: 'Failed to compute metrics.', timestamp: new Date().toISOString() });
  }
});

router.get('/aggregated', async (req, res) => {
  const { params, error } = validateQueryParams(req);
  if (error) return res.status(400).json({ success: false, errorCode: 'VALIDATION_ERROR', message: error });
  try {
    const data = await adminMetricsService.getAggregatedMetrics(params);
    return res.status(200).json({ success: true, data, meta: { generatedAt: new Date().toISOString(), note: 'Data from pre-computed daily aggregates.' } });
  } catch (err) {
    console.error('[AdminMetrics] getAggregatedMetrics failed:', err?.message);
    return res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: 'Failed to fetch aggregated metrics.' });
  }
});

router.post('/aggregate', verifySuperAdmin, async (req, res) => {
  const dateStr = req.body?.date ?? undefined;
  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ success: false, errorCode: 'VALIDATION_ERROR', message: 'date must be YYYY-MM-DD format.' });
  }
  try {
    const result = await adminMetricsAggregator.runJob(dateStr);
    return res.status(200).json({ success: true, data: result, meta: { triggeredAt: new Date().toISOString() } });
  } catch (err) {
    console.error('[AdminMetrics] Manual aggregation failed:', err?.message);
    return res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: 'Aggregation job failed.' });
  }
});

module.exports = router;









