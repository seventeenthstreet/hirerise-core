'use strict';

/**
 * src/routes/admin/adminMetrics.routes.ts
 *
 * Production-safe TypeScript route
 * Fixes:
 * - removed invalid imported types
 * - supports missing getAggregatedMetrics()
 * - preserves all existing API behavior
 */

import { Router, Request, Response } from 'express';
import { adminMetricsService } from '../../services/admin/adminMetrics.service';
import { adminMetricsAggregator } from '../../workers/adminMetrics.aggregator';
import { verifySuperAdmin } from '../../middleware/verifyAdmin.middleware';

const router = Router();

// ─────────────────────────────────────────────
// Local safe types
// ─────────────────────────────────────────────
type PeriodPreset = '7d' | '30d' | '90d' | '1y';

type MetricsQueryParams = {
  period?: PeriodPreset;
  startDate?: string;
  endDate?: string;
};

const VALID_PERIODS = new Set<PeriodPreset>([
  '7d',
  '30d',
  '90d',
  '1y',
]);

function validateQueryParams(
  req: Request
): { params: MetricsQueryParams; error?: string } {
  const { period, startDate, endDate } = req.query as Record<
    string,
    string
  >;

  if (startDate || endDate) {
    if (!startDate || !endDate) {
      return {
        params: {},
        error:
          'Both startDate and endDate are required for custom range (YYYY-MM-DD)',
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

    const diffDays =
      (endMs - startMs) / (1000 * 60 * 60 * 24);

    if (diffDays > 365) {
      return {
        params: {},
        error: 'Custom date range cannot exceed 365 days.',
      };
    }

    return {
      params: { startDate, endDate },
    };
  }

  const resolvedPeriod =
    (period as PeriodPreset) ?? '30d';

  if (!VALID_PERIODS.has(resolvedPeriod)) {
    return {
      params: {},
      error: `Invalid period. Valid options: ${[
        ...VALID_PERIODS,
      ].join(', ')}`,
    };
  }

  return {
    params: { period: resolvedPeriod },
  };
}

// ─────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────
router.get(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    const { params, error } = validateQueryParams(req);

    if (error) {
      res.status(400).json({
        success: false,
        errorCode: 'VALIDATION_ERROR',
        message: error,
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
          endpoint: 'GET /admin/metrics',
        },
      });
    } catch (err: any) {
      console.error(
        '[AdminMetrics] getMetrics failed:',
        err?.message
      );

      res.status(500).json({
        success: false,
        errorCode: 'INTERNAL_ERROR',
        message: 'Failed to compute metrics.',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

// ─────────────────────────────────────────────
// GET /aggregated
// Backward-compatible safe fallback
// ─────────────────────────────────────────────
router.get(
  '/aggregated',
  async (req: Request, res: Response): Promise<void> => {
    const { params, error } = validateQueryParams(req);

    if (error) {
      res.status(400).json({
        success: false,
        errorCode: 'VALIDATION_ERROR',
        message: error,
      });
      return;
    }

    try {
      const service = adminMetricsService as {
        getMetrics: (p: MetricsQueryParams) => Promise<any>;
        getAggregatedMetrics?: (
          p: MetricsQueryParams
        ) => Promise<any>;
      };

      const data = service.getAggregatedMetrics
        ? await service.getAggregatedMetrics(params)
        : await service.getMetrics(params);

      res.status(200).json({
        success: true,
        data,
        meta: {
          generatedAt: new Date().toISOString(),
          endpoint: 'GET /admin/metrics/aggregated',
          note:
            service.getAggregatedMetrics
              ? 'Data sourced from pre-computed daily aggregates.'
              : 'Fallback to live metrics (aggregated service unavailable).',
        },
      });
    } catch (err: any) {
      console.error(
        '[AdminMetrics] aggregated metrics failed:',
        err?.message
      );

      res.status(500).json({
        success: false,
        errorCode: 'INTERNAL_ERROR',
        message: 'Failed to fetch aggregated metrics.',
      });
    }
  }
);

// ─────────────────────────────────────────────
// POST /aggregate
// ─────────────────────────────────────────────
router.post(
  '/aggregate',
  verifySuperAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const dateStr = req.body?.date ?? undefined;

    if (
      dateStr &&
      !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ) {
      res.status(400).json({
        success: false,
        errorCode: 'VALIDATION_ERROR',
        message: 'date must be YYYY-MM-DD format.',
      });
      return;
    }

    try {
      const result =
        await adminMetricsAggregator.runJob(dateStr);

      res.status(200).json({
        success: true,
        data: result,
        meta: {
          triggeredAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      console.error(
        '[AdminMetrics] Manual aggregation failed:',
        err?.message
      );

      res.status(500).json({
        success: false,
        errorCode: 'INTERNAL_ERROR',
        message: 'Aggregation job failed.',
      });
    }
  }
);

export default router;