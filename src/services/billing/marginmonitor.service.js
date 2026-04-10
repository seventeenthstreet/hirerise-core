'use strict';

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ───────────────── Thresholds ─────────────────

const THRESHOLDS = Object.freeze({
  margin: Object.freeze({
    warnPercent: 60,
    criticalPercent: 40,
  }),
  freeBurn: Object.freeze({
    warnPercent: 40,
    criticalPercent: 60,
  }),
  anomaly: Object.freeze({
    perUserDailyUSD: 2.0,
    dailySpikeMultiplier: 3.0,
  }),
});

const USAGE_SELECT_COLUMNS = `user_id, tier, cost_usd, revenue_usd`;

// ───────────────── Helpers ─────────────────

function round(value, precision = 6) {
  return Number((Number(value ?? 0)).toFixed(precision));
}

function buildAlertKey(type, dateStr) {
  return `${type}:${dateStr}`;
}

function getYesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Production hardening:
 * centralised UTC day window builder
 * prepares Wave 4 index / partition migration
 */
function buildUTCDateWindow(dateStr) {
  return {
    startISO: new Date(`${dateStr}T00:00:00.000Z`).toISOString(),
    endISO: new Date(`${dateStr}T23:59:59.999Z`).toISOString(),
  };
}

function emptyDaySummary(dateStr) {
  return {
    dateStr,
    docCount: 0,
    totalCostUSD: 0,
    totalRevenueUSD: 0,
    freeTierCostUSD: 0,
    perUser: new Map(),
  };
}

async function fetchDayCostSummary(dateStr) {
  const { startISO, endISO } = buildUTCDateWindow(dateStr);

  const { data, error } = await supabase
    .from('usage_logs')
    .select(USAGE_SELECT_COLUMNS)
    .gte('created_at', startISO)
    .lte('created_at', endISO);

  if (error) {
    logger.error('[MarginMonitor] usage_logs fetch error', {
      error: error.message,
      dateStr,
    });
    return emptyDaySummary(dateStr);
  }

  let totalCostUSD = 0;
  let totalRevenueUSD = 0;
  let freeTierCostUSD = 0;
  const perUser = new Map();

  for (const row of data ?? []) {
    const cost = Number(row.cost_usd ?? 0);
    const revenue = Number(row.revenue_usd ?? 0);

    totalCostUSD += cost;
    totalRevenueUSD += revenue;

    if (row.tier === 'free') {
      freeTierCostUSD += cost;
    }

    if (row.user_id) {
      perUser.set(
        row.user_id,
        (perUser.get(row.user_id) ?? 0) + cost
      );
    }
  }

  return {
    dateStr,
    docCount: data?.length ?? 0,
    totalCostUSD: round(totalCostUSD, 6),
    totalRevenueUSD: round(totalRevenueUSD, 6),
    freeTierCostUSD: round(freeTierCostUSD, 6),
    perUser,
  };
}

async function fetch7DayAvgCost(endDateStr) {
  const endDate = new Date(`${endDateStr}T23:59:59.000Z`);
  const start7 = new Date(endDate);
  start7.setUTCDate(start7.getUTCDate() - 6);

  const { data, error } = await supabase
    .from('metrics_daily_snapshots')
    .select('total_cost_usd,date')
    .gte('date', start7.toISOString().split('T')[0])
    .lte('date', endDateStr);

  if (error) {
    logger.error('[MarginMonitor] snapshot fetch failed', {
      error: error.message,
      endDateStr,
    });
    return null;
  }

  if (!data?.length) return null;

  const total = data.reduce(
    (sum, row) => sum + Number(row.total_cost_usd ?? 0),
    0
  );

  return round(total / data.length, 6);
}

async function writeAlert(alert) {
  const alertKey = buildAlertKey(
    alert.type,
    alert.detail?.date ?? 'unknown'
  );

  try {
    const { data: existing } = await supabase
      .from('ai_alerts')
      .select('id')
      .eq('alert_key', alertKey)
      .limit(1);

    if (existing?.length) {
      logger.info('[MarginMonitor] Duplicate alert skipped', {
        alertKey,
      });
      return;
    }

    const now = new Date();
    const expires = new Date(now);
    expires.setUTCDate(expires.getUTCDate() + 180);

    const { error } = await supabase.from('ai_alerts').insert({
      ...alert,
      alert_key: alertKey,
      resolved: false,
      is_deleted: false,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });

    if (error) throw error;

    logger.warn('[MarginMonitor] Alert written', {
      type: alert.type,
      severity: alert.severity,
      alertKey,
    });
  } catch (error) {
    logger.error('[MarginMonitor] Failed to write alert', {
      error: error.message,
      type: alert.type,
    });
  }
}

async function checkMarginHealth(summary) {
  const { totalCostUSD, totalRevenueUSD, dateStr } = summary;
  if (!totalRevenueUSD) return;

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
  } else if (marginPercent < THRESHOLDS.margin.warnPercent) {
    await writeAlert({
      type: 'MARGIN_WARNING',
      feature: 'platform',
      severity: 'WARNING',
      title: `Margin below warning threshold: ${marginPercent.toFixed(1)}%`,
      detail: { date: dateStr, marginPercent },
    });
  }
}

async function checkFreeBurnRate(summary) {
  const { totalCostUSD, freeTierCostUSD, dateStr } = summary;
  if (!totalCostUSD) return;

  const freeBurnPercent = (freeTierCostUSD / totalCostUSD) * 100;

  if (freeBurnPercent >= THRESHOLDS.freeBurn.criticalPercent) {
    await writeAlert({
      type: 'FREE_BURN_CRITICAL',
      feature: 'free_tier',
      severity: 'CRITICAL',
      title: `Free burn critically high: ${freeBurnPercent.toFixed(1)}%`,
      detail: { date: dateStr, freeBurnPercent },
    });
  } else if (freeBurnPercent >= THRESHOLDS.freeBurn.warnPercent) {
    await writeAlert({
      type: 'FREE_BURN_WARNING',
      feature: 'free_tier',
      severity: 'WARNING',
      title: `Free burn elevated: ${freeBurnPercent.toFixed(1)}%`,
      detail: { date: dateStr, freeBurnPercent },
    });
  }
}

async function checkUserAnomalies(summary) {
  const { perUser, dateStr } = summary;

  const anomalies = [...perUser.entries()].filter(
    ([, cost]) => cost >= THRESHOLDS.anomaly.perUserDailyUSD
  );

  if (!anomalies.length) return;

  const serialisedAnomalies = anomalies.map(([userId, cost]) => ({
    userId,
    cost: round(cost, 6),
  }));

  await writeAlert({
    type: 'USER_COST_ANOMALY',
    feature: 'platform',
    severity: 'WARNING',
    title: `User anomalies detected: ${serialisedAnomalies.length} user(s)`,
    detail: { date: dateStr, anomalies: serialisedAnomalies },
  });
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
      title: `Cost spike ${multiplier.toFixed(1)}x above 7-day average`,
      detail: { date: dateStr, multiplier },
    });
  }
}

async function runDailyChecks(dateStr) {
  const targetDate = dateStr ?? getYesterdayUTC();

  const summary = await fetchDayCostSummary(targetDate);

  if (!summary.docCount) {
    logger.warn('[MarginMonitor] No usage records found for date', {
      date: targetDate,
    });
    return { checked: false, date: targetDate };
  }

  await Promise.all([
    checkMarginHealth(summary),
    checkFreeBurnRate(summary),
    checkUserAnomalies(summary),
    checkDailyCostSpike(summary),
  ]);

  return {
    checked: true,
    date: targetDate,
    summary,
  };
}

module.exports = { runDailyChecks };