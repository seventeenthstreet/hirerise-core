'use strict';

/**
 * adminMetrics.service.js
 * Converted from adminMetrics.service.ts
 */

const { db } = require('../../config/supabase');
const { usageLogsRepository } = require('./usageLogs.repository');
const { calculateCostUSD, MARGIN_THRESHOLDS, FREE_BURN_THRESHOLDS } = require('../../config/pricing.config');

const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

function resolvePeriodWindow(params) {
  const now     = new Date();
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  if (params.startDate && params.endDate) {
    const start = new Date(params.startDate);
    const end   = new Date(params.endDate);
    end.setHours(23, 59, 59, 999);
    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    return { startDate: start, endDate: end, label: `${params.startDate} to ${params.endDate}`, days };
  }

  const preset = params.period ?? '30d';
  const days   = PERIOD_DAYS[preset] ?? 30;
  const start  = new Date(now);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return { startDate: start, endDate, label: preset, days };
}

function computeTopFeatures(rows) {
  const counts = {};
  for (const row of rows) counts[row.feature] = (counts[row.feature] ?? 0) + 1;
  return Object.entries(counts).map(([feature, count]) => ({ feature, count })).sort((a, b) => b.count - a.count).slice(0, 10);
}

function computeModelBreakdown(rows) {
  const models = {};
  for (const row of rows) {
    const m = row.model || 'unknown';
    if (!models[m]) models[m] = { cost: 0, tokens: 0, calls: 0 };
    models[m].cost   += row.costUSD;
    models[m].tokens += row.totalTokens;
    models[m].calls  += 1;
  }
  return Object.entries(models)
    .map(([model, d]) => ({ model, totalCostUSD: parseFloat(d.cost.toFixed(6)), totalTokens: d.tokens, callCount: d.calls, avgCostPerCall: d.calls > 0 ? parseFloat((d.cost / d.calls).toFixed(8)) : 0 }))
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
  const freeBurnPercent = totalCostUSD > 0 ? parseFloat(((freeTierCostUSD / totalCostUSD) * 100).toFixed(1)) : 0;
  let freeBurnAlert;
  if (freeBurnPercent >= FREE_BURN_THRESHOLDS.CRITICAL_PERCENT) {
    freeBurnAlert = `CRITICAL: Free tier consuming ${freeBurnPercent}% of total AI cost.`;
  } else if (freeBurnPercent >= FREE_BURN_THRESHOLDS.WARNING_PERCENT) {
    freeBurnAlert = `WARNING: Free tier consuming ${freeBurnPercent}% of total AI cost.`;
  }
  return { marginHealthStatus, marginWarning, freeBurnAlert, freeBurnPercent };
}

async function estimateRevenueFromUsers() {
  
  const snap = await db.collection('users').where('tier', '!=', 'free').where('subscriptionStatus', '==', 'active').get();
  const INR_TO_USD = 0.012;
  let totalRevenueUSD = 0, paidUserCount = 0;
  snap.docs.forEach(doc => {
    paidUserCount++;
    totalRevenueUSD += (doc.data().planAmount ?? 0) * INR_TO_USD;
  });
  return { totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(2)), paidUserCount };
}

class AdminMetricsService {
  async getMetrics(params) {
    const period = resolvePeriodWindow(params);
    const { rows, docCount, capped } = await usageLogsRepository.getByDateRange(period.startDate, period.endDate);
    const totalUsers  = await usageLogsRepository.getTotalUserCount();
    const activeUsers = new Set(rows.map(r => r.userId)).size;

    let totalRequests = rows.length, totalTokens = 0, totalCostUSD = 0, totalRevenueUSD = 0, freeTierCostUSD = 0, paidTierCostUSD = 0;
    const paidUserIds = new Set();
    for (const row of rows) {
      totalTokens     += row.totalTokens;
      totalCostUSD    += row.costUSD;
      totalRevenueUSD += row.revenueUSD;
      if (row.tier === 'free') { freeTierCostUSD += row.costUSD; }
      else { paidTierCostUSD += row.costUSD; paidUserIds.add(row.userId); }
    }

    const hasRevenueData = rows.some(r => r.revenueUSD > 0);
    let paidUserCount = paidUserIds.size;
    if (!hasRevenueData) {
      const estimated = await estimateRevenueFromUsers();
      totalRevenueUSD = estimated.totalRevenueUSD;
      paidUserCount   = estimated.paidUserCount;
    }

    const grossMarginUSD     = parseFloat((totalRevenueUSD - totalCostUSD).toFixed(6));
    const grossMarginPercent = totalRevenueUSD > 0 ? parseFloat(((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2)) : 0;
    const avgCostPerRequest  = totalRequests > 0 ? parseFloat((totalCostUSD / totalRequests).toFixed(8)) : 0;
    const avgRevenuePerPaidUser = paidUserCount > 0 ? parseFloat((totalRevenueUSD / paidUserCount).toFixed(4)) : 0;

    const dataSource = docCount === 0 ? 'aggregated' : capped ? 'hybrid' : 'live';

    return {
      period: period.label, startDate: period.startDate.toISOString().split('T')[0], endDate: period.endDate.toISOString().split('T')[0],
      totalUsers, activeUsers, totalRequests, totalTokens,
      totalCostUSD: parseFloat(totalCostUSD.toFixed(6)), totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(4)),
      grossMarginUSD, grossMarginPercent, freeTierCostUSD: parseFloat(freeTierCostUSD.toFixed(6)), paidTierCostUSD: parseFloat(paidTierCostUSD.toFixed(6)),
      avgCostPerRequest, avgRevenuePerPaidUser, topFeatures: computeTopFeatures(rows), modelBreakdown: computeModelBreakdown(rows),
      healthAlerts: computeHealthAlerts(grossMarginPercent, freeTierCostUSD, totalCostUSD),
      dataSource, generatedAt: new Date().toISOString(), periodDays: period.days,
      ...(capped && { _warning: `Query returned ${docCount} docs (limit: 10,000). Use /admin/metrics/aggregated for large periods.` }),
    };
  }

  async getAggregatedMetrics(params) {
    const period   = resolvePeriodWindow(params);
    
    const startStr = period.startDate.toISOString().split('T')[0];
    const endStr   = period.endDate.toISOString().split('T')[0];

    const snap = await db.collection('metrics').doc('daily').collection('snapshots')
      .where('date', '>=', startStr).where('date', '<=', endStr).orderBy('date', 'asc').get();

    if (snap.empty) {
      return { period: period.label, startDate: startStr, endDate: endStr, totalUsers: 0, _warning: 'No aggregated data found. Run the daily aggregation job first.' };
    }

    let totalRequests = 0, totalTokens = 0, totalCostUSD = 0, totalRevenueUSD = 0, freeTierCostUSD = 0, paidTierCostUSD = 0, paidUserCount = 0;
    const featureCounts = {};
    snap.docs.forEach(doc => {
      const d = doc.data();
      totalRequests   += d.totalRequests   ?? 0;
      totalTokens     += d.totalTokens     ?? 0;
      totalCostUSD    += d.totalCostUSD    ?? 0;
      totalRevenueUSD += d.totalRevenueUSD ?? 0;
      freeTierCostUSD += d.freeTierCostUSD ?? 0;
      paidTierCostUSD += d.paidTierCostUSD ?? 0;
      paidUserCount   += d.paidUserCount   ?? 0;
      if (d.featureCounts) for (const [f, c] of Object.entries(d.featureCounts)) featureCounts[f] = (featureCounts[f] ?? 0) + c;
    });

    const totalUsers         = await usageLogsRepository.getTotalUserCount();
    const grossMarginUSD     = parseFloat((totalRevenueUSD - totalCostUSD).toFixed(6));
    const grossMarginPercent = totalRevenueUSD > 0 ? parseFloat(((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2)) : 0;
    const topFeatures        = Object.entries(featureCounts).map(([feature, count]) => ({ feature, count })).sort((a, b) => b.count - a.count).slice(0, 10);

    return {
      period: period.label, startDate: startStr, endDate: endStr, totalUsers, activeUsers: 0,
      totalRequests, totalTokens, totalCostUSD: parseFloat(totalCostUSD.toFixed(6)), totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(4)),
      grossMarginUSD, grossMarginPercent, freeTierCostUSD: parseFloat(freeTierCostUSD.toFixed(6)), paidTierCostUSD: parseFloat(paidTierCostUSD.toFixed(6)),
      avgCostPerRequest: totalRequests > 0 ? parseFloat((totalCostUSD / totalRequests).toFixed(8)) : 0,
      avgRevenuePerPaidUser: paidUserCount > 0 ? parseFloat((totalRevenueUSD / paidUserCount).toFixed(4)) : 0,
      topFeatures, healthAlerts: computeHealthAlerts(grossMarginPercent, freeTierCostUSD, totalCostUSD),
      dataSource: 'aggregated', generatedAt: new Date().toISOString(), periodDays: period.days,
    };
  }
}

const adminMetricsService = new AdminMetricsService();
module.exports = { adminMetricsService };









