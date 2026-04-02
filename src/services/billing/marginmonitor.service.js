'use strict';

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ─── Thresholds ─────────────────────────────────────────────────────────────

const THRESHOLDS = {
  margin: { warnPercent: 60, criticalPercent: 40 },
  freeBurn: { warnPercent: 40, criticalPercent: 60 },
  anomaly: { perUserDailyUSD: 2.0, dailySpikeMultiplier: 3.0 },
};

// ─── Fetch today's cost summary ─────────────────────────────────────────────

async function fetchDayCostSummary(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end   = new Date(`${dateStr}T23:59:59.999Z`);

  const { data, error } = await supabase
    .from('usage_logs')
    .select('*')
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString());

  if (error) {
    logger.error('[MarginMonitor] usage_logs fetch error:', error.message);
    return { docCount: 0 };
  }

  let totalCostUSD = 0;
  let totalRevenueUSD = 0;
  let freeTierCostUSD = 0;
  const perUser = {};

  for (const d of data || []) {
    totalCostUSD += d.cost_usd ?? 0;
    totalRevenueUSD += d.revenue_usd ?? 0;

    if (d.tier === 'free') {
      freeTierCostUSD += d.cost_usd ?? 0;
    }

    if (d.user_id) {
      perUser[d.user_id] = (perUser[d.user_id] ?? 0) + (d.cost_usd ?? 0);
    }
  }

  return {
    dateStr,
    docCount: data?.length ?? 0,
    totalCostUSD: +totalCostUSD.toFixed(6),
    totalRevenueUSD: +totalRevenueUSD.toFixed(4),
    freeTierCostUSD: +freeTierCostUSD.toFixed(6),
    perUser,
  };
}

// ─── Fetch 7-day average ────────────────────────────────────────────────────

async function fetch7DayAvgCost(endDateStr) {
  const endDate = new Date(`${endDateStr}T23:59:59.000Z`);
  const start7 = new Date(endDate);
  start7.setDate(start7.getDate() - 7);

  const { data } = await supabase
    .from('metrics_daily_snapshots')
    .select('total_cost_usd, date')
    .gte('date', start7.toISOString().split('T')[0])
    .lt('date', endDateStr);

  if (!data || data.length === 0) return null;

  const totals = data.map(d => d.total_cost_usd ?? 0);
  const avg = totals.reduce((s, v) => s + v, 0) / totals.length;

  return +avg.toFixed(6);
}

// ─── Write alert ────────────────────────────────────────────────────────────

async function writeAlert(alert) {
  try {
    const { error } = await supabase.from('ai_alerts').insert({
      ...alert,
      resolved: false,
      isDeleted: false,
      created_at: new Date().toISOString(),
      expires_at: (() => {
        const d = new Date();
        d.setDate(d.getDate() + 180);
        return d.toISOString();
      })(),
    });

    if (error) throw error;

    logger.warn('[MarginMonitor] Alert written', {
      type: alert.type,
      severity: alert.severity,
    });

  } catch (err) {
    logger.error('[MarginMonitor] Failed to write alert', {
      error: err.message,
    });
  }
}

// ─── Checks ─────────────────────────────────────────────────────────────────

async function checkMarginHealth(summary) {
  const { totalCostUSD, totalRevenueUSD, dateStr } = summary;
  if (totalRevenueUSD === 0) return;

  const grossMargin = totalRevenueUSD - totalCostUSD;
  const marginPercent = (grossMargin / totalRevenueUSD) * 100;

  if (marginPercent < THRESHOLDS.margin.criticalPercent) {
    await writeAlert({
      type: 'MARGIN_CRITICAL',
      feature: 'platform',
      severity: 'CRITICAL',
      title: `Margin critically low: ${marginPercent.toFixed(1)}%`,
      detail: { date: dateStr, marginPercent },
    });
  }
}

async function checkFreeBurnRate(summary) {
  const { totalCostUSD, freeTierCostUSD, dateStr } = summary;
  if (totalCostUSD === 0) return;

  const freeBurnPercent = (freeTierCostUSD / totalCostUSD) * 100;

  if (freeBurnPercent >= THRESHOLDS.freeBurn.warnPercent) {
    await writeAlert({
      type: 'FREE_BURN_WARNING',
      feature: 'free_tier',
      severity: 'WARNING',
      title: `Free burn ${freeBurnPercent.toFixed(1)}%`,
      detail: { date: dateStr, freeBurnPercent },
    });
  }
}

async function checkUserAnomalies(summary) {
  const { perUser, dateStr } = summary;

  const anomalies = Object.entries(perUser)
    .filter(([_, cost]) => cost >= THRESHOLDS.anomaly.perUserDailyUSD);

  if (anomalies.length) {
    await writeAlert({
      type: 'USER_COST_ANOMALY',
      feature: 'platform',
      severity: 'WARNING',
      title: `User anomalies detected`,
      detail: { date: dateStr, anomalies },
    });
  }
}

async function checkDailyCostSpike(summary) {
  const { totalCostUSD, dateStr } = summary;

  const avgCost = await fetch7DayAvgCost(dateStr);
  if (!avgCost) return;

  const multiplier = totalCostUSD / avgCost;

  if (multiplier >= THRESHOLDS.anomaly.dailySpikeMultiplier) {
    await writeAlert({
      type: 'COST_SPIKE',
      feature: 'platform',
      severity: 'WARNING',
      title: `Cost spike ${multiplier.toFixed(1)}x`,
      detail: { date: dateStr, multiplier },
    });
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function runDailyChecks(dateStr) {
  const targetDate =
    dateStr ??
    (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().split('T')[0];
    })();

  const summary = await fetchDayCostSummary(targetDate);

  if (!summary.docCount) {
    return { checked: false };
  }

  await Promise.all([
    checkMarginHealth(summary),
    checkFreeBurnRate(summary),
    checkUserAnomalies(summary),
    checkDailyCostSpike(summary),
  ]);

  return { checked: true, summary };
}

module.exports = { runDailyChecks };