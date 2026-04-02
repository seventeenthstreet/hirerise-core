'use strict';

/**
 * adminMetrics.service.js — FULLY FIXED (Supabase)
 */

const { supabase } = require('../../config/supabase');

const { usageLogsRepository } = require('./usageLogs.repository');
const {
  calculateCostUSD,
  MARGIN_THRESHOLDS,
  FREE_BURN_THRESHOLDS
} = require('../../config/pricing.config');

const PERIOD_DAYS = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365
};

// ─────────────────────────────────────────────────────────
// PERIOD
// ─────────────────────────────────────────────────────────
function resolvePeriodWindow(params) {
  const now = new Date();

  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  if (params.startDate && params.endDate) {
    const start = new Date(params.startDate);
    const end = new Date(params.endDate);

    end.setHours(23, 59, 59, 999);

    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

    return {
      startDate: start,
      endDate: end,
      label: `${params.startDate} to ${params.endDate}`,
      days
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
    days
  };
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function computeTopFeatures(rows) {
  const counts = {};

  for (const row of rows) {
    counts[row.feature] = (counts[row.feature] ?? 0) + 1;
  }

  return Object.entries(counts)
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function computeModelBreakdown(rows) {
  const models = {};

  for (const row of rows) {
    const m = row.model || 'unknown';

    if (!models[m]) {
      models[m] = { cost: 0, tokens: 0, calls: 0 };
    }

    models[m].cost += row.costUSD;
    models[m].tokens += row.totalTokens;
    models[m].calls += 1;
  }

  return Object.entries(models)
    .map(([model, d]) => ({
      model,
      totalCostUSD: parseFloat(d.cost.toFixed(6)),
      totalTokens: d.tokens,
      callCount: d.calls,
      avgCostPerCall: d.calls > 0
        ? parseFloat((d.cost / d.calls).toFixed(8))
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

  const freeBurnPercent = totalCostUSD > 0
    ? parseFloat((freeTierCostUSD / totalCostUSD * 100).toFixed(1))
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

// ─────────────────────────────────────────────────────────
// FIXED: USERS QUERY
// ─────────────────────────────────────────────────────────
async function estimateRevenueFromUsers() {

  const { data, error } = await supabase
    .from('users')
    .select('planAmount')
    .neq('tier', 'free')
    .eq('subscriptionStatus', 'active');

  if (error) throw error;

  const INR_TO_USD = 0.012;

  let totalRevenueUSD = 0;
  let paidUserCount = 0;

  for (const row of data || []) {
    paidUserCount++;
    totalRevenueUSD += (row.planAmount ?? 0) * INR_TO_USD;
  }

  return {
    totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(2)),
    paidUserCount
  };
}

// ─────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────
class AdminMetricsService {

  async getMetrics(params) {

    const period = resolvePeriodWindow(params);

    const { rows, docCount, capped } =
      await usageLogsRepository.getByDateRange(
        period.startDate,
        period.endDate
      );

    const totalUsers = await usageLogsRepository.getTotalUserCount();

    const activeUsers = new Set(rows.map(r => r.userId)).size;

    let totalRequests = rows.length;
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const paidUserIds = new Set();

    for (const row of rows) {
      totalTokens += row.totalTokens;
      totalCostUSD += row.costUSD;
      totalRevenueUSD += row.revenueUSD;

      if (row.tier === 'free') {
        freeTierCostUSD += row.costUSD;
      } else {
        paidTierCostUSD += row.costUSD;
        paidUserIds.add(row.userId);
      }
    }

    const hasRevenueData = rows.some(r => r.revenueUSD > 0);

    let paidUserCount = paidUserIds.size;

    if (!hasRevenueData) {
      const estimated = await estimateRevenueFromUsers();
      totalRevenueUSD = estimated.totalRevenueUSD;
      paidUserCount = estimated.paidUserCount;
    }

    const grossMarginUSD =
      parseFloat((totalRevenueUSD - totalCostUSD).toFixed(6));

    const grossMarginPercent =
      totalRevenueUSD > 0
        ? parseFloat((grossMarginUSD / totalRevenueUSD * 100).toFixed(2))
        : 0;

    return {
      period: period.label,
      startDate: period.startDate.toISOString().split('T')[0],
      endDate: period.endDate.toISOString().split('T')[0],
      totalUsers,
      activeUsers,
      totalRequests,
      totalTokens,
      totalCostUSD,
      totalRevenueUSD,
      grossMarginUSD,
      grossMarginPercent,
      freeTierCostUSD,
      paidTierCostUSD,
      topFeatures: computeTopFeatures(rows),
      modelBreakdown: computeModelBreakdown(rows),
      healthAlerts: computeHealthAlerts(
        grossMarginPercent,
        freeTierCostUSD,
        totalCostUSD
      ),
      dataSource: capped ? 'hybrid' : 'live',
      generatedAt: new Date().toISOString(),
      periodDays: period.days
    };
  }

  // ─────────────────────────────────────────────────────────
  // FIXED: Aggregated Metrics (NO SUBCOLLECTIONS)
  // ─────────────────────────────────────────────────────────
  async getAggregatedMetrics(params) {

    const period = resolvePeriodWindow(params);

    const startStr = period.startDate.toISOString().split('T')[0];
    const endStr = period.endDate.toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('metrics_daily_snapshots')
      .select('*')
      .gte('date', startStr)
      .lte('date', endStr)
      .order('date', { ascending: true });

    if (error) throw error;

    if (!data || data.length === 0) {
      return {
        period: period.label,
        startDate: startStr,
        endDate: endStr,
        totalUsers: 0,
        _warning: 'No aggregated data found.'
      };
    }

    let totalRequests = 0;
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;
    let paidUserCount = 0;

    const featureCounts = {};

    for (const d of data) {
      totalRequests += d.totalRequests ?? 0;
      totalTokens += d.totalTokens ?? 0;
      totalCostUSD += d.totalCostUSD ?? 0;
      totalRevenueUSD += d.totalRevenueUSD ?? 0;
      freeTierCostUSD += d.freeTierCostUSD ?? 0;
      paidTierCostUSD += d.paidTierCostUSD ?? 0;
      paidUserCount += d.paidUserCount ?? 0;

      if (d.featureCounts) {
        for (const [f, c] of Object.entries(d.featureCounts)) {
          featureCounts[f] = (featureCounts[f] ?? 0) + c;
        }
      }
    }

    return {
      period: period.label,
      startDate: startStr,
      endDate: endStr,
      totalRequests,
      totalTokens,
      totalCostUSD,
      totalRevenueUSD,
      grossMarginUSD: totalRevenueUSD - totalCostUSD,
      grossMarginPercent:
        totalRevenueUSD > 0
          ? (totalRevenueUSD - totalCostUSD) / totalRevenueUSD * 100
          : 0,
      topFeatures: Object.entries(featureCounts)
        .map(([feature, count]) => ({ feature, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      healthAlerts: computeHealthAlerts(
        totalRevenueUSD > 0
          ? (totalRevenueUSD - totalCostUSD) / totalRevenueUSD * 100
          : 0,
        freeTierCostUSD,
        totalCostUSD
      ),
      dataSource: 'aggregated',
      generatedAt: new Date().toISOString(),
      periodDays: period.days
    };
  }
}

const adminMetricsService = new AdminMetricsService();

module.exports = {
  adminMetricsService
};