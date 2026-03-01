'use strict';

/**
 * adminMetrics.routes.js
 * Converted from adminMetrics.routes.ts
 */

const { Router }                 = require('express');
const { adminMetricsService }    = require('../../services/admin/adminMetrics.service');
const { adminMetricsAggregator } = require('../../workers/adminMetrics.aggregator');
const { verifySuperAdmin }       = require('../../middleware/verifyAdmin.middleware');

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
    const data = await adminMetricsService.getMetrics(params);
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