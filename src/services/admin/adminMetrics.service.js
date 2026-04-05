'use strict';

/**
 * src/services/admin/adminMetrics.service.js
 * Production-ready Supabase-native admin metrics service
 */

const { supabase } = require('../../config/supabase');
const { usageLogsRepository } = require('./usageLogs.repository');
const {
  MARGIN_THRESHOLDS,
  FREE_BURN_THRESHOLDS
} = require('../../config/pricing.config');

const PERIOD_DAYS = Object.freeze({
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365
});

const INR_TO_USD = 0.012;

// ───────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────

function toNumber(value, precision = null) {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 0;
  return precision === null ? num : Number(num.toFixed(precision));
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function resolvePeriodWindow(params = {}) {
  const now = new Date();
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  if (params.startDate && params.endDate) {
    const startDate = new Date(params.startDate);
    const customEnd = new Date(params.endDate);
    customEnd.setHours(23, 59, 59, 999);

    const days = Math.max(
      1,
      Math.ceil((customEnd - startDate) / 86400000)
    );

    return {
      startDate,
      endDate: customEnd,
      label: `${params.startDate} to ${params.endDate}`,
      days
    };
  }

  const preset = params.period ?? '30d';
  const days = PERIOD_DAYS[preset] ?? 30;

  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  return {
    startDate,
    endDate,
    label: preset,
    days
  };
}

function computeTopFeatures(rows = []) {
  const counts = new Map();

  for (const row of rows) {
    const feature = row.feature || 'unknown';
    counts.set(feature, (counts.get(feature) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function computeModelBreakdown(rows = []) {
  const models = new Map();

  for (const row of rows) {
    const model = row.model || 'unknown';
    const existing = models.get(model) || {
      totalCostUSD: 0,
      totalTokens: 0,
      callCount: 0
    };

    existing.totalCostUSD += toNumber(row.costUSD);
    existing.totalTokens += toNumber(row.totalTokens);
    existing.callCount += 1;

    models.set(model, existing);
  }

  return [...models.entries()]
    .map(([model, data]) => ({
      model,
      totalCostUSD: toNumber(data.totalCostUSD, 6),
      totalTokens: data.totalTokens,
      callCount: data.callCount,
      avgCostPerCall:
        data.callCount > 0
          ? toNumber(data.totalCostUSD / data.callCount, 8)
          : 0
    }))
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD);
}

function computeHealthAlerts(grossMarginPercent, freeTierCostUSD, totalCostUSD) {
  let marginHealthStatus = 'HEALTHY';
  let marginWarning;

  if (grossMarginPercent < MARGIN_THRESHOLDS.CRITICAL_PERCENT) {
    marginHealthStatus = 'CRITICAL';
    marginWarning = `CRITICAL: Gross margin ${grossMarginPercent.toFixed(1)}% is below ${MARGIN_THRESHOLDS.CRITICAL_PERCENT}% threshold.`;
  } else if (grossMarginPercent < MARGIN_THRESHOLDS.HEALTHY_PERCENT) {
    marginHealthStatus = 'WARNING';
    marginWarning = `WARNING: Gross margin ${grossMarginPercent.toFixed(1)}% is below healthy ${MARGIN_THRESHOLDS.HEALTHY_PERCENT}% target.`;
  }

  const freeBurnPercent =
    totalCostUSD > 0
      ? toNumber((freeTierCostUSD / totalCostUSD) * 100, 1)
      : 0;

  let freeBurnAlert;

  if (freeBurnPercent >= FREE_BURN_THRESHOLDS.CRITICAL_PERCENT) {
    freeBurnAlert = `CRITICAL: Free tier consuming ${freeBurnPercent}% of total AI cost.`;
  } else if (freeBurnPercent >= FREE_BURN_THRESHOLDS.WARNING_PERCENT) {
    freeBurnAlert = `WARNING: Free tier consuming ${freeBurnPercent}% of total AI cost.`;
  }

  return {
    marginHealthStatus,
    marginWarning,
    freeBurnAlert,
    freeBurnPercent
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
    totalRevenueUSD += toNumber(row.plan_amount) * INR_TO_USD;
  }

  return {
    totalRevenueUSD: toNumber(totalRevenueUSD, 2),
    paidUserCount
  };
}

// ───────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────

class AdminMetricsService {
  async getMetrics(params = {}) {
    const period = resolvePeriodWindow(params);

    const { rows, docCount, capped } =
      await usageLogsRepository.getByDateRange(
        period.startDate,
        period.endDate
      );

    const totalUsers = await usageLogsRepository.getTotalUserCount();
    const activeUsers = new Set(rows.map((r) => r.userId)).size;

    let totalRequests = rows.length;
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const paidUserIds = new Set();

    for (const row of rows) {
      totalTokens += toNumber(row.totalTokens);
      totalCostUSD += toNumber(row.costUSD);
      totalRevenueUSD += toNumber(row.revenueUSD);

      if (row.tier === 'free') {
        freeTierCostUSD += toNumber(row.costUSD);
      } else {
        paidTierCostUSD += toNumber(row.costUSD);
        if (row.userId) paidUserIds.add(row.userId);
      }
    }

    const hasRevenueData = rows.some((r) => toNumber(r.revenueUSD) > 0);
    let paidUserCount = paidUserIds.size;

    if (!hasRevenueData) {
      const estimated = await estimateRevenueFromUsers();
      totalRevenueUSD = estimated.totalRevenueUSD;
      paidUserCount = estimated.paidUserCount;
    }

    const grossMarginUSD = toNumber(
      totalRevenueUSD - totalCostUSD,
      6
    );

    const grossMarginPercent =
      totalRevenueUSD > 0
        ? toNumber((grossMarginUSD / totalRevenueUSD) * 100, 2)
        : 0;

    return {
      period: period.label,
      startDate: formatDate(period.startDate),
      endDate: formatDate(period.endDate),
      totalUsers,
      activeUsers,
      totalRequests,
      totalTokens,
      totalCostUSD: toNumber(totalCostUSD, 6),
      totalRevenueUSD: toNumber(totalRevenueUSD, 4),
      grossMarginUSD,
      grossMarginPercent,
      freeTierCostUSD: toNumber(freeTierCostUSD, 6),
      paidTierCostUSD: toNumber(paidTierCostUSD, 6),
      avgCostPerRequest:
        totalRequests > 0
          ? toNumber(totalCostUSD / totalRequests, 8)
          : 0,
      avgRevenuePerPaidUser:
        paidUserCount > 0
          ? toNumber(totalRevenueUSD / paidUserCount, 4)
          : 0,
      topFeatures: computeTopFeatures(rows),
      modelBreakdown: computeModelBreakdown(rows),
      healthAlerts: computeHealthAlerts(
        grossMarginPercent,
        freeTierCostUSD,
        totalCostUSD
      ),
      dataSource: docCount === 0 ? 'aggregated' : capped ? 'hybrid' : 'live',
      generatedAt: new Date().toISOString(),
      periodDays: period.days,
      ...(capped && {
        _warning: `Query returned ${docCount} docs (limit: 10,000). Use /admin/metrics/aggregated for large periods.`
      })
    };
  }

  async getAggregatedMetrics(params = {}) {
    const period = resolvePeriodWindow(params);
    const startStr = formatDate(period.startDate);
    const endStr = formatDate(period.endDate);

    const { data, error } = await supabase
      .from('metrics_daily_snapshots')
      .select('*')
      .gte('date', startStr)
      .lte('date', endStr)
      .order('date', { ascending: true });

    if (error) {
      throw new Error(`Aggregated metrics fetch failed: ${error.message}`);
    }

    if (!data?.length) {
      return {
        period: period.label,
        startDate: startStr,
        endDate: endStr,
        totalUsers: 0,
        _warning: 'No aggregated data found. Run the daily aggregation job first.'
      };
    }

    let totalRequests = 0;
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;
    let paidUserCount = 0;
    const featureCounts = new Map();

    for (const row of data) {
      totalRequests += toNumber(row.totalRequests);
      totalTokens += toNumber(row.totalTokens);
      totalCostUSD += toNumber(row.totalCostUSD);
      totalRevenueUSD += toNumber(row.totalRevenueUSD);
      freeTierCostUSD += toNumber(row.freeTierCostUSD);
      paidTierCostUSD += toNumber(row.paidTierCostUSD);
      paidUserCount += toNumber(row.paidUserCount);

      for (const [feature, count] of Object.entries(row.featureCounts || {})) {
        featureCounts.set(feature, (featureCounts.get(feature) ?? 0) + count);
      }
    }

    const totalUsers = await usageLogsRepository.getTotalUserCount();
    const grossMarginUSD = toNumber(totalRevenueUSD - totalCostUSD, 6);
    const grossMarginPercent =
      totalRevenueUSD > 0
        ? toNumber((grossMarginUSD / totalRevenueUSD) * 100, 2)
        : 0;

    return {
      period: period.label,
      startDate: startStr,
      endDate: endStr,
      totalUsers,
      activeUsers: 0,
      totalRequests,
      totalTokens,
      totalCostUSD: toNumber(totalCostUSD, 6),
      totalRevenueUSD: toNumber(totalRevenueUSD, 4),
      grossMarginUSD,
      grossMarginPercent,
      freeTierCostUSD: toNumber(freeTierCostUSD, 6),
      paidTierCostUSD: toNumber(paidTierCostUSD, 6),
      avgCostPerRequest:
        totalRequests > 0
          ? toNumber(totalCostUSD / totalRequests, 8)
          : 0,
      avgRevenuePerPaidUser:
        paidUserCount > 0
          ? toNumber(totalRevenueUSD / paidUserCount, 4)
          : 0,
      topFeatures: [...featureCounts.entries()]
        .map(([feature, count]) => ({ feature, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      healthAlerts: computeHealthAlerts(
        grossMarginPercent,
        freeTierCostUSD,
        totalCostUSD
      ),
      dataSource: 'aggregated',
      generatedAt: new Date().toISOString(),
      periodDays: period.days
    };
  }
}

module.exports = {
  adminMetricsService: new AdminMetricsService()
};