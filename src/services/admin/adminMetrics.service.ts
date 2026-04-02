'use strict';

const { supabase } = require('../../config/supabase');
const { usageLogsRepository } = require('./usageLogs.repository');
const { MARGIN_THRESHOLDS, FREE_BURN_THRESHOLDS } = require('../../config/pricing.config');

// ─── TYPES ──────────────────────────────────────────────────────────────────

type CostRow = {
  userId: string;
  feature: string;
  model?: string;
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

// ─── Period ────────────────────────────────────────────────────────────────

const PERIOD_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

function resolvePeriodWindow(params: any): PeriodWindow {
  const now = new Date();
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  if (params.startDate && params.endDate) {
    const start = new Date(params.startDate);
    const end = new Date(params.endDate);
    end.setHours(23, 59, 59, 999);

    const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    return { startDate: start, endDate: end, label: `${params.startDate} to ${params.endDate}`, days };
  }

  const preset = params.period ?? '30d';
  const days = PERIOD_DAYS[preset] ?? 30;

  const start = new Date(now);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);

  return { startDate: start, endDate, label: preset, days };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function computeTopFeatures(rows: CostRow[]) {
  const counts: Record<string, number> = {};

  for (const r of rows) {
    counts[r.feature] = (counts[r.feature] ?? 0) + 1;
  }

  return Object.entries(counts)
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function computeModelBreakdown(rows: CostRow[]) {
  const models: Record<string, { cost: number; tokens: number; calls: number }> = {};

  for (const r of rows) {
    const m = r.model || 'unknown';

    if (!models[m]) {
      models[m] = { cost: 0, tokens: 0, calls: 0 };
    }

    models[m].cost += r.costUSD;
    models[m].tokens += r.totalTokens;
    models[m].calls += 1;
  }

  return Object.entries(models)
    .map(([model, d]) => ({
      model,
      totalCostUSD: +d.cost.toFixed(6),
      totalTokens: d.tokens,
      callCount: d.calls,
      avgCostPerCall: d.calls ? +(d.cost / d.calls).toFixed(8) : 0,
    }))
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD);
}

function computeHealthAlerts(grossMarginPercent: number, freeTierCostUSD: number, totalCostUSD: number) {
  let marginHealthStatus: string = 'HEALTHY';
  let marginWarning: string | undefined;

  if (grossMarginPercent < MARGIN_THRESHOLDS.CRITICAL_PERCENT) {
    marginHealthStatus = 'CRITICAL';
    marginWarning = 'CRITICAL margin';
  } else if (grossMarginPercent < MARGIN_THRESHOLDS.HEALTHY_PERCENT) {
    marginHealthStatus = 'WARNING';
    marginWarning = 'Low margin';
  }

  const freeBurnPercent = totalCostUSD
    ? +((freeTierCostUSD / totalCostUSD) * 100).toFixed(1)
    : 0;

  return {
    marginHealthStatus,
    marginWarning,
    freeBurnPercent,
  };
}

// ─── Revenue ───────────────────────────────────────────────────────────────

async function estimateRevenueFromUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('planAmount')
    .neq('tier', 'free')
    .eq('subscriptionStatus', 'active');

  if (error) throw error;

  let totalRevenueUSD = 0;
  let paidUserCount = 0;

  for (const u of data || []) {
    paidUserCount++;
    totalRevenueUSD += (u.planAmount ?? 0) * 0.012;
  }

  return {
    totalRevenueUSD: +totalRevenueUSD.toFixed(2),
    paidUserCount,
  };
}

// ─── Active users ───────────────────────────────────────────────────────────

function computeActiveUsers(rows: CostRow[]): number {
  return new Set(rows.map((r: CostRow) => r.userId)).size;
}

// ─── SERVICE ────────────────────────────────────────────────────────────────

class AdminMetricsService {

  async getMetrics(params: any) {
    const period = resolvePeriodWindow(params);

    const { rows, docCount, capped } =
      await usageLogsRepository.getByDateRange(period.startDate, period.endDate);

    const totalUsers = await usageLogsRepository.getTotalUserCount();
    const activeUsers = computeActiveUsers(rows);

    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const paidUserIds = new Set<string>();

    for (const r of rows as CostRow[]) {
      totalTokens += r.totalTokens;
      totalCostUSD += r.costUSD;
      totalRevenueUSD += r.revenueUSD;

      if (r.tier === 'free') {
        freeTierCostUSD += r.costUSD;
      } else {
        paidTierCostUSD += r.costUSD;
        paidUserIds.add(r.userId);
      }
    }

    let paidUserCount = paidUserIds.size;

    if (!(rows as CostRow[]).some((r: CostRow) => r.revenueUSD > 0)) {
      const est = await estimateRevenueFromUsers();
      totalRevenueUSD = est.totalRevenueUSD;
      paidUserCount = est.paidUserCount;
    }

    const grossMarginUSD = +(totalRevenueUSD - totalCostUSD).toFixed(6);
    const grossMarginPercent = totalRevenueUSD
      ? +((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2)
      : 0;

    return {
      period: period.label,
      startDate: period.startDate.toISOString().split('T')[0],
      endDate: period.endDate.toISOString().split('T')[0],

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

      avgCostPerRequest: rows.length ? totalCostUSD / rows.length : 0,
      avgRevenuePerPaidUser: paidUserCount ? totalRevenueUSD / paidUserCount : 0,

      topFeatures: computeTopFeatures(rows as CostRow[]),
      modelBreakdown: computeModelBreakdown(rows as CostRow[]),
      healthAlerts: computeHealthAlerts(grossMarginPercent, freeTierCostUSD, totalCostUSD),

      dataSource: capped ? 'hybrid' : 'live',
      generatedAt: new Date().toISOString(),
      periodDays: period.days,
    };
  }
}

export const adminMetricsService = new AdminMetricsService();