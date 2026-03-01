'use strict';
/**
 * adminMetrics.routes.ts
 *
 * Routes:
 *   GET /admin/metrics              → Live metrics for a period
 *   GET /admin/metrics/aggregated   → Pre-computed daily aggregates (large periods)
 *   POST /admin/metrics/aggregate   → Trigger manual aggregation (super_admin only)
 *
 * PLACEMENT in server.js:
 *   Add this line BEFORE the 404 handler:
 *
 *   app.use(`${API_PREFIX}/admin/metrics`,
 *     authenticate,
 *     verifyAdmin,
 *     require('./routes/admin/adminMetrics.routes')
 *   );
 *
 * NOTE: authenticate is already applied per-route in server.js.
 *       verifyAdmin adds the admin-claim check on top.
 *       No duplication — this matches the existing pattern in ai-observability.routes.js
 */

import { Router, Request, Response } from 'express';
import { adminMetricsService }    from '../../services/admin/adminMetrics.service';
import { adminMetricsAggregator } from '../../workers/adminMetrics.aggregator';
import { verifySuperAdmin }       from '../../middleware/verifyAdmin.middleware';
import type { MetricsQueryParams, PeriodPreset } from '../../types/metrics.types';

const router = Router();

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_PERIODS = new Set<PeriodPreset>(['7d', '30d', '90d', '1y']);

function validateQueryParams(req: Request): { params: MetricsQueryParams; error?: string } {
  const { period, startDate, endDate } = req.query as Record<string, string>;

  // Custom range
  if (startDate || endDate) {
    if (!startDate || !endDate) {
      return { params: {}, error: 'Both startDate and endDate are required for custom range (YYYY-MM-DD)' };
    }
    const startMs = Date.parse(startDate);
    const endMs   = Date.parse(endDate);
    if (isNaN(startMs) || isNaN(endMs)) {
      return { params: {}, error: 'Invalid date format. Use YYYY-MM-DD.' };
    }
    if (endMs < startMs) {
      return { params: {}, error: 'endDate must be >= startDate.' };
    }
    const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24);
    if (diffDays > 365) {
      return { params: {}, error: 'Custom date range cannot exceed 365 days.' };
    }
    return { params: { startDate, endDate } };
  }

  // Preset
  const resolvedPeriod = (period as PeriodPreset) ?? '30d';
  if (!VALID_PERIODS.has(resolvedPeriod)) {
    return { params: {}, error: `Invalid period. Valid options: ${[...VALID_PERIODS].join(', ')}` };
  }

  return { params: { period: resolvedPeriod } };
}

// ─── GET /admin/metrics ────────────────────────────────────────────────────────

/**
 * GET /admin/metrics?period=30d
 * GET /admin/metrics?period=7d
 * GET /admin/metrics?period=1y
 * GET /admin/metrics?startDate=2025-01-01&endDate=2025-01-31
 *
 * Returns full cost + margin metrics for the requested period.
 * Uses live usageLogs query (capped at 10k docs).
 * Add `?mode=aggregated` to use pre-computed daily snapshots instead.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { params, error } = validateQueryParams(req);

  if (error) {
    res.status(400).json({
      success:   false,
      errorCode: 'VALIDATION_ERROR',
      message:   error,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const data = await adminMetricsService.getMetrics(params);

    res.status(200).json({
      success: true,
      data,
      meta: {
        generatedAt: new Date().toISOString(),
        endpoint:    'GET /admin/metrics',
      },
    });
  } catch (err: any) {
    console.error('[AdminMetrics] getMetrics failed:', err?.message);
    res.status(500).json({
      success:   false,
      errorCode: 'INTERNAL_ERROR',
      message:   'Failed to compute metrics. Check server logs.',
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── GET /admin/metrics/aggregated ────────────────────────────────────────────

/**
 * GET /admin/metrics/aggregated?period=90d
 *
 * Reads from pre-computed daily snapshots.
 * Much faster for 90d / 1y periods — recommended for dashboards.
 * Requires daily aggregation job to have run for the requested dates.
 */
router.get('/aggregated', async (req: Request, res: Response): Promise<void> => {
  const { params, error } = validateQueryParams(req);

  if (error) {
    res.status(400).json({ success: false, errorCode: 'VALIDATION_ERROR', message: error });
    return;
  }

  try {
    const data = await adminMetricsService.getAggregatedMetrics(params);

    res.status(200).json({
      success: true,
      data,
      meta: {
        generatedAt: new Date().toISOString(),
        endpoint:    'GET /admin/metrics/aggregated',
        note:        'Data sourced from pre-computed daily aggregates. Run POST /admin/metrics/aggregate to refresh.',
      },
    });
  } catch (err: any) {
    console.error('[AdminMetrics] getAggregatedMetrics failed:', err?.message);
    res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Failed to fetch aggregated metrics.',
    });
  }
});

// ─── POST /admin/metrics/aggregate ────────────────────────────────────────────

/**
 * POST /admin/metrics/aggregate
 * Body: { date?: "YYYY-MM-DD" }
 *
 * Triggers manual aggregation for a date (defaults to yesterday).
 * Super admin only. Idempotent — safe to re-run.
 */
router.post('/aggregate', verifySuperAdmin, async (req: Request, res: Response): Promise<void> => {
  const dateStr = req.body?.date ?? undefined;

  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'date must be YYYY-MM-DD format.',
    });
    return;
  }

  try {
    const result = await adminMetricsAggregator.runJob(dateStr);
    res.status(200).json({
      success: true,
      data:    result,
      meta:    { triggeredAt: new Date().toISOString() },
    });
  } catch (err: any) {
    console.error('[AdminMetrics] Manual aggregation failed:', err?.message);
    res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Aggregation job failed.',
    });
  }
});

export default router;