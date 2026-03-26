'use strict';

/**
 * marginMonitor.service.js — Margin Health & Cost Anomaly Detection
 * =================================================================
 * PRODUCTION HARDENED — Phase 7
 *
 * RESPONSIBILITIES:
 *   1. Gross margin health check (warn if < 60%)
 *   2. Free tier burn rate alert (warn if free tier > 40% of cost)
 *   3. AI cost anomaly detection (single user spending > threshold)
 *   4. Daily cost spike detection (today's cost > N× 7-day average)
 *
 * HOW IT RUNS:
 *   Called by the daily aggregation worker (already exists at
 *   src/workers/daily-aggregation.worker.js).
 *   Add marginMonitor.runDailyChecks() to DailyAggregationWorker.runJob().
 *
 * ALERT OUTPUT:
 *   Currently: writes to ai_alerts collection (already exists in codebase)
 *              + logs to Winston logger (already exists)
 *
 *   Future:    Replace alertService.fire() with:
 *              - Slack webhook (add SLACK_ALERT_WEBHOOK to .env)
 *              - Email via SendGrid
 *              - PagerDuty
 *
 * THRESHOLDS (adjust as business scales):
 *   MARGIN_WARN_PERCENT:         60%  — below this = unhealthy
 *   MARGIN_CRITICAL_PERCENT:     40%  — below this = critical
 *   FREE_BURN_WARN_PERCENT:      40%  — free tier consuming >40% of AI cost
 *   FREE_BURN_CRITICAL_PERCENT:  60%  — free tier consuming >60% of AI cost
 *   USER_ANOMALY_USD:            $2   — single user > $2/day = anomaly
 *   DAILY_SPIKE_MULTIPLIER:      3×   — today's cost > 3× 7-day avg = spike
 */

const { db, Timestamp } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ─── Thresholds ───────────────────────────────────────────────────────────────

const THRESHOLDS = {
  margin: {
    warnPercent:     60,
    criticalPercent: 40,
  },
  freeBurn: {
    warnPercent:     40,
    criticalPercent: 60,
  },
  anomaly: {
    perUserDailyUSD:    2.00,   // single user spending $2+/day = suspicious
    dailySpikeMultiplier: 3.0,  // today > 3× rolling average = spike
  },
};

// ─── Fetch today's cost summary from usageLogs ────────────────────────────────

async function fetchDayCostSummary(dateStr) {
  
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end   = new Date(`${dateStr}T23:59:59.999Z`);

  const snap = await db
    .collection('usageLogs')
    .where('createdAt', '>=', Timestamp.fromDate(start))
    .where('createdAt', '<=', Timestamp.fromDate(end))
    .get();

  let totalCostUSD    = 0;
  let totalRevenueUSD = 0;
  let freeTierCostUSD = 0;
  const perUser = {};

  snap.docs.forEach(doc => {
    const d = doc.data();
    totalCostUSD    += d.costUSD    ?? 0;
    totalRevenueUSD += d.revenueUSD ?? 0;

    if (d.tier === 'free') {
      freeTierCostUSD += d.costUSD ?? 0;
    }

    if (d.userId) {
      perUser[d.userId] = (perUser[d.userId] ?? 0) + (d.costUSD ?? 0);
    }
  });

  return {
    dateStr,
    docCount:       snap.size,
    totalCostUSD:   parseFloat(totalCostUSD.toFixed(6)),
    totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(4)),
    freeTierCostUSD: parseFloat(freeTierCostUSD.toFixed(6)),
    perUser,
  };
}

// ─── Fetch 7-day rolling average cost ────────────────────────────────────────

async function fetch7DayAvgCost(endDateStr) {
  
  const endDate = new Date(`${endDateStr}T23:59:59.000Z`);
  const start7  = new Date(endDate);
  start7.setDate(start7.getDate() - 7);

  // Read from pre-aggregated daily snapshots (faster than scanning usageLogs)
  const snap = await db
    .collection('metrics')
    .doc('daily')
    .collection('snapshots')
    .where('date', '>=', start7.toISOString().split('T')[0])
    .where('date', '<',  endDateStr)
    .get();

  if (snap.empty) return null;

  const totals = snap.docs.map(d => d.data().totalCostUSD ?? 0);
  const avg    = totals.reduce((s, v) => s + v, 0) / totals.length;
  return parseFloat(avg.toFixed(6));
}

// ─── Write alert to Firestore ai_alerts ───────────────────────────────────────

async function writeAlert(alert) {
  
  try {
    const ref = db.collection('ai_alerts').doc();
    await ref.set({
      ...alert,
      resolved:  false,
      isDeleted: false,
      createdAt: Timestamp.now(),
      expiresAt: (() => {
        const d = new Date();
        d.setDate(d.getDate() + 180);
        return Timestamp.fromDate(d);
      })(),
    });
    logger.warn('[MarginMonitor] Alert written', { type: alert.type, severity: alert.severity });
  } catch (err) {
    logger.error('[MarginMonitor] Failed to write alert', { error: err.message });
  }
}

// ─── Check 1: Margin health ───────────────────────────────────────────────────

async function checkMarginHealth(summary) {
  const { totalCostUSD, totalRevenueUSD, dateStr } = summary;
  if (totalRevenueUSD === 0) return; // no revenue = no margin calc

  const grossMargin    = totalRevenueUSD - totalCostUSD;
  const marginPercent  = (grossMargin / totalRevenueUSD) * 100;

  if (marginPercent < THRESHOLDS.margin.criticalPercent) {
    await writeAlert({
      type:     'MARGIN_CRITICAL',
      feature:  'platform',
      severity: 'CRITICAL',
      title:    `Gross margin critically low: ${marginPercent.toFixed(1)}%`,
      detail: {
        date: dateStr,
        marginPercent: parseFloat(marginPercent.toFixed(2)),
        totalCostUSD,
        totalRevenueUSD,
        grossMarginUSD: parseFloat(grossMargin.toFixed(4)),
        threshold: THRESHOLDS.margin.criticalPercent,
        action: 'Review pricing immediately. Consider restricting free tier or raising plan prices.',
      },
    });
  } else if (marginPercent < THRESHOLDS.margin.warnPercent) {
    await writeAlert({
      type:     'MARGIN_WARNING',
      feature:  'platform',
      severity: 'WARNING',
      title:    `Gross margin below target: ${marginPercent.toFixed(1)}%`,
      detail: {
        date: dateStr,
        marginPercent: parseFloat(marginPercent.toFixed(2)),
        totalCostUSD,
        totalRevenueUSD,
        threshold: THRESHOLDS.margin.warnPercent,
        action: 'Monitor daily. Consider tightening free tier limits.',
      },
    });
  }
}

// ─── Check 2: Free tier burn rate ─────────────────────────────────────────────

async function checkFreeBurnRate(summary) {
  const { totalCostUSD, freeTierCostUSD, dateStr } = summary;
  if (totalCostUSD === 0) return;

  const freeBurnPercent = (freeTierCostUSD / totalCostUSD) * 100;

  if (freeBurnPercent >= THRESHOLDS.freeBurn.criticalPercent) {
    await writeAlert({
      type:     'FREE_BURN_CRITICAL',
      feature:  'free_tier',
      severity: 'CRITICAL',
      title:    `Free tier consuming ${freeBurnPercent.toFixed(1)}% of AI cost`,
      detail: {
        date: dateStr,
        freeBurnPercent: parseFloat(freeBurnPercent.toFixed(2)),
        freeTierCostUSD,
        totalCostUSD,
        threshold: THRESHOLDS.freeBurn.criticalPercent,
        action: 'Reduce free tier monthly quota immediately (src/middleware/tierQuota.middleware.js)',
      },
    });
  } else if (freeBurnPercent >= THRESHOLDS.freeBurn.warnPercent) {
    await writeAlert({
      type:     'FREE_BURN_WARNING',
      feature:  'free_tier',
      severity: 'WARNING',
      title:    `Free tier burn rate elevated: ${freeBurnPercent.toFixed(1)}%`,
      detail: {
        date: dateStr,
        freeBurnPercent: parseFloat(freeBurnPercent.toFixed(2)),
        freeTierCostUSD,
        totalCostUSD,
        action: 'Review free tier quota limits.',
      },
    });
  }
}

// ─── Check 3: Per-user anomaly detection ─────────────────────────────────────

async function checkUserAnomalies(summary) {
  const { perUser, dateStr } = summary;
  const threshold = THRESHOLDS.anomaly.perUserDailyUSD;

  const anomalies = Object.entries(perUser)
    .filter(([_, cost]) => cost >= threshold)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);  // top 10 anomalous users

  if (anomalies.length > 0) {
    await writeAlert({
      type:     'USER_COST_ANOMALY',
      feature:  'platform',
      severity: 'WARNING',
      title:    `${anomalies.length} user(s) with abnormal AI cost on ${dateStr}`,
      detail: {
        date: dateStr,
        threshold,
        topAnomalousUsers: anomalies.map(([userId, cost]) => ({
          userId,
          costUSD: parseFloat(cost.toFixed(6)),
        })),
        action: 'Review users for abuse. Consider adding per-user daily caps.',
      },
    });
  }
}

// ─── Check 4: Daily cost spike ────────────────────────────────────────────────

async function checkDailyCostSpike(summary) {
  const { totalCostUSD, dateStr } = summary;
  const avgCost = await fetch7DayAvgCost(dateStr);

  if (avgCost === null || avgCost === 0) return; // no baseline yet

  const spikeMultiplier = totalCostUSD / avgCost;

  if (spikeMultiplier >= THRESHOLDS.anomaly.dailySpikeMultiplier) {
    await writeAlert({
      type:     'COST_SPIKE',
      feature:  'platform',
      severity: spikeMultiplier >= 5 ? 'CRITICAL' : 'WARNING',
      title:    `Daily AI cost spike: ${spikeMultiplier.toFixed(1)}× 7-day average`,
      detail: {
        date: dateStr,
        todayCostUSD:   totalCostUSD,
        avgCostUSD:     avgCost,
        spikeMultiplier: parseFloat(spikeMultiplier.toFixed(2)),
        threshold:      THRESHOLDS.anomaly.dailySpikeMultiplier,
        action: 'Investigate unusual traffic. Check for API abuse or runaway loops.',
      },
    });
  }
}

// ─── Main daily check runner ──────────────────────────────────────────────────

/**
 * runDailyChecks(dateStr)
 *
 * Runs all margin/burn/anomaly checks for a given date.
 * Called by DailyAggregationWorker.runJob() after aggregation completes.
 *
 * @param {string} dateStr - 'YYYY-MM-DD', defaults to yesterday
 */
async function runDailyChecks(dateStr) {
  const targetDate = dateStr ?? (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  logger.info('[MarginMonitor] Running daily checks for', { date: targetDate });

  const summary = await fetchDayCostSummary(targetDate);

  if (summary.docCount === 0) {
    logger.info('[MarginMonitor] No usage data for date — skipping checks', { date: targetDate });
    return { date: targetDate, checked: false, reason: 'no_data' };
  }

  await Promise.allSettled([
    checkMarginHealth(summary),
    checkFreeBurnRate(summary),
    checkUserAnomalies(summary),
    checkDailyCostSpike(summary),
  ]);

  logger.info('[MarginMonitor] Daily checks complete', {
    date:            targetDate,
    totalCostUSD:    summary.totalCostUSD,
    totalRevenueUSD: summary.totalRevenueUSD,
    freeBurnPct:     summary.totalCostUSD > 0
      ? ((summary.freeTierCostUSD / summary.totalCostUSD) * 100).toFixed(1) + '%'
      : '0%',
  });

  return { date: targetDate, checked: true, summary };
}

module.exports = { runDailyChecks, THRESHOLDS };









