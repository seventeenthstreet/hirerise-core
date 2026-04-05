'use strict';

/**
 * src/services/admin/adminMetrics.service.js
 *
 * FULLY PRODUCTION SAFE (Supabase)
 */

const { getClient, withRetry } = require('../../config/supabase');
const { usageLogsRepository } = require('./usageLogs.repository');
const {
  calculateCostUSD,
  MARGIN_THRESHOLDS,
  FREE_BURN_THRESHOLDS,
} = require('../../config/pricing.config');

const PERIOD_DAYS = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getDb() {
  return getClient();
}

function resolvePeriodWindow(params = {}) {
  const now = new Date();

  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  if (params.startDate && params.endDate) {
    const start = new Date(params.startDate);
    const end = new Date(params.endDate);

    end.setHours(23, 59, 59, 999);

    const days = Math.max(
      1,
      Math.ceil((end - start) / (1000 * 60 * 60 * 24))
    );

    return {
      startDate: start,
      endDate: end,
      label: `${params.startDate} to ${params.endDate}`,
      days,
    };
  }

  const preset = params.period ?? '30d';
  const days = PERIOD_DAYS[preset] ?? 30;

  const start = new Date(now);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);

  return {
    startDate: start,
    endDate,
    label: preset,
    days,
  };
}

function computeTopFeatures(rows) {
  const counts = Object.create(null);

  for (const row of rows) {
    const feature = row.feature ?? 'unknown';
    counts[feature] = (counts[feature] ?? 0) + 1;
  }

  return Object.entries(counts)
    .map(([feature, count]) => ({
      feature,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function computeModelBreakdown(rows) {
  const models = Object.create(null);

  for (const row of rows) {
    const model = row.model ?? 'unknown';

    if (!models[model]) {
      models[model] = {
        cost: 0,
        tokens: 0,
        calls: 0,
      };
    }

    models[model].cost += row.costUSD ?? 0;
    models[model].tokens += row.totalTokens ?? 0;
    models[model].calls += 1;
  }

  return Object.entries(models)
    .map(([model, d]) => ({
      model,
      totalCostUSD: Number(d.cost.toFixed(6)),
      totalTokens: d.tokens,
      callCount: d.calls,
      avgCostPerCall:
        d.calls > 0
          ? Number((d.cost / d.calls).toFixed(8))
          : 0,
    }))
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD);
}

function computeHealthAlerts(
  grossMarginPercent,
  freeTierCostUSD,
  totalCostUSD
) {
  let marginHealthStatus = 'HEALTHY';
  let marginWarning;

  if (
    grossMarginPercent <
    MARGIN_THRESHOLDS.CRITICAL_PERCENT
  ) {
    marginHealthStatus = 'CRITICAL';
    marginWarning =
      `CRITICAL: Gross margin ${grossMarginPercent.toFixed(1)}% ` +
      `is below ${MARGIN_THRESHOLDS.CRITICAL_PERCENT}% threshold.`;
  } else if (
    grossMarginPercent <
    MARGIN_THRESHOLDS.HEALTHY_PERCENT
  ) {
    marginHealthStatus = 'WARNING';
    marginWarning =
      `WARNING: Gross margin ${grossMarginPercent.toFixed(1)}% ` +
      `is below healthy ${MARGIN_THRESHOLDS.HEALTHY_PERCENT}% target.`;
  }

  const freeBurnPercent =
    totalCostUSD > 0
      ? Number(
          ((freeTierCostUSD / totalCostUSD) * 100).toFixed(1)
        )
      : 0;

  let freeBurnAlert;

  if (
    freeBurnPercent >=
    FREE_BURN_THRESHOLDS.CRITICAL_PERCENT
  ) {
    freeBurnAlert =
      `CRITICAL: Free tier consuming ${freeBurnPercent}% of total AI cost.`;
  } else if (
    freeBurnPercent >=
    FREE_BURN_THRESHOLDS.WARNING_PERCENT
  ) {
    freeBurnAlert =
      `WARNING: Free tier consuming ${freeBurnPercent}% of total AI cost.`;
  }

  return {
    marginHealthStatus,
    marginWarning,
    freeBurnAlert,
    freeBurnPercent,
  };
}

async function estimateRevenueFromUsers() {
  const db = getDb();

  const { data, error } = await withRetry(() =>
    db
      .from('users')
      .select('plan_amount')
      .neq('tier', 'free')
      .eq('subscription_status', 'active')
  );

  if (error) throw error;

  const INR_TO_USD = 0.012;

  let totalRevenueUSD = 0;
  let paidUserCount = 0;

  for (const row of data ?? []) {
    paidUserCount += 1;
    totalRevenueUSD +=
      (row.plan_amount ?? 0) * INR_TO_USD;
  }

  return {
    totalRevenueUSD: Number(totalRevenueUSD.toFixed(2)),
    paidUserCount,
  };
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────
class AdminMetricsService {
  async getMetrics(params = {}) {
    const period = resolvePeriodWindow(params);

    const { rows, capped } =
      await usageLogsRepository.getByDateRange(
        period.startDate,
        period.endDate
      );

    const totalUsers =
      await usageLogsRepository.getTotalUserCount();

    const activeUsers = new Set(
      rows.map(r => r.userId)
    ).size;

    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const paidUserIds = new Set();

    for (const row of rows) {
      totalTokens += row.totalTokens ?? 0;
      totalCostUSD += row.costUSD ?? 0;
      totalRevenueUSD += row.revenueUSD ?? 0;

      if (row.tier === 'free') {
        freeTierCostUSD += row.costUSD ?? 0;
      } else {
        paidTierCostUSD += row.costUSD ?? 0;
        paidUserIds.add(row.userId);
      }
    }

    const hasRevenueData = rows.some(
      r => (r.revenueUSD ?? 0) > 0
    );

    let paidUserCount = paidUserIds.size;

    if (!hasRevenueData) {
      const estimated =
        await estimateRevenueFromUsers();
      totalRevenueUSD = estimated.totalRevenueUSD;
      paidUserCount = estimated.paidUserCount;
    }

    const grossMarginUSD = Number(
      (totalRevenueUSD - totalCostUSD).toFixed(6)
    );

    const grossMarginPercent =
      totalRevenueUSD > 0
        ? Number(
            (
              (grossMarginUSD / totalRevenueUSD) *
              100
            ).toFixed(2)
          )
        : 0;

    return {
      period: period.label,
      startDate: period.startDate
        .toISOString()
        .split('T')[0],
      endDate: period.endDate
        .toISOString()
        .split('T')[0],
      totalUsers,
      activeUsers,
      totalRequests: rows.length,
      totalTokens,
      totalCostUSD,
      totalRevenueUSD,
      grossMarginUSD,
      grossMarginPercent,
      freeTierCostUSD,
      paidTierCostUSD,
      paidUserCount,
      topFeatures: computeTopFeatures(rows),
      modelBreakdown: computeModelBreakdown(rows),
      healthAlerts: computeHealthAlerts(
        grossMarginPercent,
        freeTierCostUSD,
        totalCostUSD
      ),
      dataSource: capped ? 'hybrid' : 'live',
      generatedAt: new Date().toISOString(),
      periodDays: period.days,
    };
  }

  async getAggregatedMetrics(params = {}) {
    const db = getDb();
    const period = resolvePeriodWindow(params);

    const startStr = period.startDate
      .toISOString()
      .split('T')[0];
    const endStr = period.endDate
      .toISOString()
      .split('T')[0];

    const { data, error } = await withRetry(() =>
      db
        .from('metrics_daily_snapshots')
        .select('*')
        .gte('date', startStr)
        .lte('date', endStr)
        .order('date', { ascending: true })
    );

    if (error) throw error;

    if (!data?.length) {
      return {
        period: period.label,
        startDate: startStr,
        endDate: endStr,
        totalUsers: 0,
        _warning: 'No aggregated data found.',
      };
    }

    let totalRequests = 0;
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const featureCounts = Object.create(null);

    for (const d of data) {
      totalRequests += d.totalRequests ?? 0;
      totalTokens += d.totalTokens ?? 0;
      totalCostUSD += d.totalCostUSD ?? 0;
      totalRevenueUSD += d.totalRevenueUSD ?? 0;
      freeTierCostUSD += d.freeTierCostUSD ?? 0;
      paidTierCostUSD += d.paidTierCostUSD ?? 0;

      if (d.featureCounts) {
        for (const [f, c] of Object.entries(
          d.featureCounts
        )) {
          featureCounts[f] =
            (featureCounts[f] ?? 0) + c;
        }
      }
    }

    const grossMarginUSD =
      totalRevenueUSD - totalCostUSD;

    const grossMarginPercent =
      totalRevenueUSD > 0
        ? (grossMarginUSD / totalRevenueUSD) * 100
        : 0;

    return {
      period: period.label,
      startDate: startStr,
      endDate: endStr,
      totalRequests,
      totalTokens,
      totalCostUSD,
      totalRevenueUSD,
      grossMarginUSD,
      grossMarginPercent,
      topFeatures: Object.entries(featureCounts)
        .map(([feature, count]) => ({
          feature,
          count,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      healthAlerts: computeHealthAlerts(
        grossMarginPercent,
        freeTierCostUSD,
        totalCostUSD
      ),
      dataSource: 'aggregated',
      generatedAt: new Date().toISOString(),
      periodDays: period.days,
    };
  }
}

const adminMetricsService =
  new AdminMetricsService();

module.exports = {
  adminMetricsService,
};