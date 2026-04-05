// eslint-disable-next-line @typescript-eslint/no-require-imports
const { supabase } = require('../../config/supabase') as {
  supabase: ReturnType<typeof import('../../config/supabase').getClient>;
};
import { usageLogsRepository } from './usageLogs.repository';
import {
  MARGIN_THRESHOLDS,
  FREE_BURN_THRESHOLDS,
} from '../../config/pricing.config';

type CostRow = {
  userId: string;
  feature: string;
  model?: string | null;
  costUSD: number;
  revenueUSD: number;
  totalTokens: number;
  tier: string;
};

type PeriodWindow = {
  startDate: Date;
  endDate: Date;
  label: string;
  days: number;
};

type MetricsParams = {
  period?: '7d' | '30d' | '90d' | '1y';
  startDate?: string;
  endDate?: string;
};

const PERIOD_DAYS: Record<NonNullable<MetricsParams['period']>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

const INR_TO_USD = 0.012;

function round(value: number, precision = 6): number {
  return Number((value || 0).toFixed(precision));
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function resolvePeriodWindow(params: MetricsParams = {}): PeriodWindow {
  const now = new Date();
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  if (params.startDate && params.endDate) {
    const startDate = new Date(params.startDate);
    const customEnd = new Date(params.endDate);
    customEnd.setHours(23, 59, 59, 999);

    const days = Math.max(
      1,
      Math.ceil((customEnd.getTime() - startDate.getTime()) / 86400000)
    );

    return {
      startDate,
      endDate: customEnd,
      label: `${params.startDate} to ${params.endDate}`,
      days,
    };
  }

  const preset = params.period ?? '30d';
  const days = PERIOD_DAYS[preset];

  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  return {
    startDate,
    endDate,
    label: preset,
    days,
  };
}

function computeTopFeatures(rows: CostRow[]) {
  const counts = new Map<string, number>();

  for (const row of rows) {
    counts.set(row.feature, (counts.get(row.feature) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function computeModelBreakdown(rows: CostRow[]) {
  const models = new Map<
    string,
    { cost: number; tokens: number; calls: number }
  >();

  for (const row of rows) {
    const model = row.model || 'unknown';
    const current = models.get(model) ?? {
      cost: 0,
      tokens: 0,
      calls: 0,
    };

    current.cost += row.costUSD ?? 0;
    current.tokens += row.totalTokens ?? 0;
    current.calls += 1;

    models.set(model, current);
  }

  return [...models.entries()]
    .map(([model, data]) => ({
      model,
      totalCostUSD: round(data.cost, 6),
      totalTokens: data.tokens,
      callCount: data.calls,
      avgCostPerCall: data.calls
        ? round(data.cost / data.calls, 8)
        : 0,
    }))
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD);
}

function computeHealthAlerts(
  grossMarginPercent: number,
  freeTierCostUSD: number,
  totalCostUSD: number
) {
  let marginHealthStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL' =
    'HEALTHY';
  let marginWarning: string | undefined;
  let freeBurnAlert: string | undefined;

  if (grossMarginPercent < MARGIN_THRESHOLDS.CRITICAL_PERCENT) {
    marginHealthStatus = 'CRITICAL';
    marginWarning = 'CRITICAL margin';
  } else if (
    grossMarginPercent < MARGIN_THRESHOLDS.HEALTHY_PERCENT
  ) {
    marginHealthStatus = 'WARNING';
    marginWarning = 'Low margin';
  }

  const freeBurnPercent = totalCostUSD
    ? round((freeTierCostUSD / totalCostUSD) * 100, 1)
    : 0;

  if (freeBurnPercent >= FREE_BURN_THRESHOLDS.CRITICAL_PERCENT) {
    freeBurnAlert = `CRITICAL: Free tier consuming ${freeBurnPercent}% of total AI cost.`;
  } else if (
    freeBurnPercent >= FREE_BURN_THRESHOLDS.WARNING_PERCENT
  ) {
    freeBurnAlert = `WARNING: Free tier consuming ${freeBurnPercent}% of total AI cost.`;
  }

  return {
    marginHealthStatus,
    marginWarning,
    freeBurnPercent,
    freeBurnAlert,
  };
}

async function estimateRevenueFromUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('plan_amount')
    .neq('tier', 'free')
    .eq('subscription_status', 'active');

  if (error) {
    throw new Error(`Revenue estimation failed: ${error.message}`);
  }

  let totalRevenueUSD = 0;
  let paidUserCount = 0;

  for (const row of data ?? []) {
    paidUserCount += 1;
    totalRevenueUSD += (row.plan_amount ?? 0) * INR_TO_USD;
  }

  return {
    totalRevenueUSD: round(totalRevenueUSD, 2),
    paidUserCount,
  };
}

function computeActiveUsers(rows: CostRow[]): number {
  return new Set(rows.map((row) => row.userId)).size;
}

class AdminMetricsService {
  async getMetrics(params: MetricsParams = {}) {
    const period = resolvePeriodWindow(params);

    const { rows, docCount, capped } =
      await usageLogsRepository.getByDateRange(
        period.startDate,
        period.endDate
      );

    const totalUsers =
      await usageLogsRepository.getTotalUserCount();

    const typedRows = rows as CostRow[];
    const activeUsers = computeActiveUsers(typedRows);

    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const paidUserIds = new Set<string>();

    for (const row of typedRows) {
      totalTokens += row.totalTokens ?? 0;
      totalCostUSD += row.costUSD ?? 0;
      totalRevenueUSD += row.revenueUSD ?? 0;

      if (row.tier === 'free') {
        freeTierCostUSD += row.costUSD ?? 0;
      } else {
        paidTierCostUSD += row.costUSD ?? 0;
        if (row.userId) paidUserIds.add(row.userId);
      }
    }

    let paidUserCount = paidUserIds.size;

    if (!typedRows.some((row) => row.revenueUSD > 0)) {
      const estimate = await estimateRevenueFromUsers();
      totalRevenueUSD = estimate.totalRevenueUSD;
      paidUserCount = estimate.paidUserCount;
    }

    const grossMarginUSD = round(
      totalRevenueUSD - totalCostUSD,
      6
    );

    const grossMarginPercent = totalRevenueUSD
      ? round((grossMarginUSD / totalRevenueUSD) * 100, 2)
      : 0;

    return {
      period: period.label,
      startDate: formatDate(period.startDate),
      endDate: formatDate(period.endDate),

      totalUsers,
      activeUsers,

      totalRequests: typedRows.length,
      totalTokens,

      totalCostUSD: round(totalCostUSD, 6),
      totalRevenueUSD: round(totalRevenueUSD, 4),
      grossMarginUSD,
      grossMarginPercent,

      freeTierCostUSD: round(freeTierCostUSD, 6),
      paidTierCostUSD: round(paidTierCostUSD, 6),

      avgCostPerRequest: typedRows.length
        ? round(totalCostUSD / typedRows.length, 8)
        : 0,

      avgRevenuePerPaidUser: paidUserCount
        ? round(totalRevenueUSD / paidUserCount, 4)
        : 0,

      topFeatures: computeTopFeatures(typedRows),
      modelBreakdown: computeModelBreakdown(typedRows),

      healthAlerts: computeHealthAlerts(
        grossMarginPercent,
        freeTierCostUSD,
        totalCostUSD
      ),

      dataSource:
        docCount === 0 ? 'aggregated' : capped ? 'hybrid' : 'live',

      generatedAt: new Date().toISOString(),
      periodDays: period.days,

      ...(capped && {
        _warning: `Query returned ${docCount} docs (limit: 10,000). Use /admin/metrics/aggregated for large periods.`,
      }),
    };
  }
}

export const adminMetricsService = new AdminMetricsService();