'use strict';
/**
 * adminMetrics.service.ts
 *
 * Core business logic for GET /admin/metrics
 *
 * ARCHITECTURE NOTE (based on codebase audit):
 *
 *   This codebase already has:
 *     - ai_cost_tracking: per-user/feature/day cost aggregates (ai-observability.repository.js)
 *     - ai_logs:          per-call raw logs (feature, latency, tokens)
 *     - users:            tier, planAmount, subscriptionStatus
 *
 *   What it LACKS for /admin/metrics:
 *     - Per-request tier tagging on cost logs (ai_cost_tracking has no tier field)
 *     - revenueUSD per request (payment is activation-only, not per-call)
 *     - usageLogs collection (new — needed for per-request margin analytics)
 *
 *   Integration strategy:
 *     - NEW: usageLogs collection (logs tier + revenue per call)
 *     - EXISTING: ai_cost_tracking for historical cost data
 *     - EXISTING: users collection for total/active user counts
 *     - HYBRID: merge both sources when usageLogs is sparse
 *
 * PERFORMANCE STRATEGY:
 *   < 10k docs   → compute live from usageLogs
 *   >= 10k docs  → return capped flag + recommend aggregated endpoint
 *   aggregated   → read from metrics/daily/{YYYY-MM-DD} pre-aggregated docs
 */

const { db, Timestamp } = require('../../core/supabaseDbShim');
import { usageLogsRepository } from './usageLogs.repository';
import { calculateCostUSD, MARGIN_THRESHOLDS, FREE_BURN_THRESHOLDS } from '../../config/pricing.config';
import type {
  AdminMetricsResponse,
  MetricsQueryParams,
  PeriodWindow,
  TopFeature,
  ModelCostBreakdown,
  HealthAlerts,
  CostRow,
} from '../../types/metrics.types';

// ─── Period resolution ────────────────────────────────────────────────────────

const PERIOD_DAYS: Record<string, number> = {
  '7d':  7,
  '30d': 30,
  '90d': 90,
  '1y':  365,
};

function resolvePeriodWindow(params: MetricsQueryParams): PeriodWindow {
  const now     = new Date();
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  // Custom date range
  if (params.startDate && params.endDate) {
    const start = new Date(params.startDate);
    const end   = new Date(params.endDate);
    end.setHours(23, 59, 59, 999);
    const diffMs   = end.getTime() - start.getTime();
    const days     = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return { startDate: start, endDate: end, label: `${params.startDate} to ${params.endDate}`, days };
  }

  // Preset
  const preset = params.period ?? '30d';
  const days   = PERIOD_DAYS[preset] ?? 30;
  const start  = new Date(now);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);

  return { startDate: start, endDate, label: preset, days };
}

// ─── Computation helpers ──────────────────────────────────────────────────────

function computeTopFeatures(rows: CostRow[]): TopFeature[] {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.feature] = (counts[row.feature] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function computeModelBreakdown(rows: CostRow[]): ModelCostBreakdown[] {
  const models: Record<string, { cost: number; tokens: number; calls: number }> = {};
  for (const row of rows) {
    const m = row.model || 'unknown';
    if (!models[m]) models[m] = { cost: 0, tokens: 0, calls: 0 };
    models[m].cost   += row.costUSD;
    models[m].tokens += row.totalTokens;
    models[m].calls  += 1;
  }
  return Object.entries(models)
    .map(([model, d]) => ({
      model,
      totalCostUSD:   parseFloat(d.cost.toFixed(6)),
      totalTokens:    d.tokens,
      callCount:      d.calls,
      avgCostPerCall: d.calls > 0 ? parseFloat((d.cost / d.calls).toFixed(8)) : 0,
    }))
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD);
}

function computeHealthAlerts(
  grossMarginPercent: number,
  freeTierCostUSD:    number,
  totalCostUSD:       number,
): HealthAlerts {
  let marginHealthStatus: HealthAlerts['marginHealthStatus'] = 'HEALTHY';
  let marginWarning: string | undefined;

  if (grossMarginPercent < MARGIN_THRESHOLDS.CRITICAL_PERCENT) {
    marginHealthStatus = 'CRITICAL';
    marginWarning = `CRITICAL: Gross margin ${grossMarginPercent.toFixed(1)}% is below ${MARGIN_THRESHOLDS.CRITICAL_PERCENT}% threshold. Review pricing immediately.`;
  } else if (grossMarginPercent < MARGIN_THRESHOLDS.HEALTHY_PERCENT) {
    marginHealthStatus = 'WARNING';
    marginWarning = `WARNING: Gross margin ${grossMarginPercent.toFixed(1)}% is below healthy ${MARGIN_THRESHOLDS.HEALTHY_PERCENT}% target.`;
  }

  const freeBurnPercent = totalCostUSD > 0
    ? parseFloat(((freeTierCostUSD / totalCostUSD) * 100).toFixed(1))
    : 0;

  let freeBurnAlert: string | undefined;
  if (freeBurnPercent >= FREE_BURN_THRESHOLDS.CRITICAL_PERCENT) {
    freeBurnAlert = `CRITICAL: Free tier consuming ${freeBurnPercent}% of total AI cost. Immediate rate limiting or feature restriction required.`;
  } else if (freeBurnPercent >= FREE_BURN_THRESHOLDS.WARNING_PERCENT) {
    freeBurnAlert = `WARNING: Free tier consuming ${freeBurnPercent}% of total AI cost. Consider tightening free tier limits.`;
  }

  return { marginHealthStatus, marginWarning, freeBurnAlert, freeBurnPercent };
}

// ─── Fallback: estimate revenue from users collection ─────────────────────────
// When usageLogs.revenueUSD is 0 (new collection, no data yet),
// we estimate from the users collection planAmount.

async function estimateRevenueFromUsers(startDate: Date, endDate: Date): Promise<{
  totalRevenueUSD: number;
  paidUserCount:   number;
}> {
  
  const snap = await db
    .collection('users')
    .where('tier', '!=', 'free')
    .where('subscriptionStatus', '==', 'active')
    .get();

  // We can't filter subscriptionStart by date range without an index,
  // so we compute all active paid users as a proxy for the period.
  const INR_TO_USD = 0.012;
  let totalRevenueUSD = 0;
  let paidUserCount   = 0;

  snap.docs.forEach(doc => {
    const data = doc.data();
    paidUserCount++;
    const planAmountINR = data.planAmount ?? 0;
    totalRevenueUSD += planAmountINR * INR_TO_USD;
  });

  return {
    totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(2)),
    paidUserCount,
  };
}

// ─── Active users: distinct userId count in period ───────────────────────────

function computeActiveUsers(rows: CostRow[]): number {
  return new Set(rows.map(r => r.userId)).size;
}

// ─── Main service ─────────────────────────────────────────────────────────────

class AdminMetricsService {

  /**
   * getMetrics — Main entry point for GET /admin/metrics
   *
   * Computes all KPIs for the requested period.
   * Hybrid data source: usageLogs (if populated) + users collection.
   */
  async getMetrics(params: MetricsQueryParams): Promise<AdminMetricsResponse> {
    const period = resolvePeriodWindow(params);

    // ── 1. Fetch usage logs for period ──────────────────────────────────────
    const { rows, docCount, capped } = await usageLogsRepository.getByDateRange(
      period.startDate,
      period.endDate,
    );

    // ── 2. Total user count (from users collection) ─────────────────────────
    const totalUsers = await usageLogsRepository.getTotalUserCount();

    // ── 3. Active users: distinct userIds in this period ────────────────────
    const activeUsers = computeActiveUsers(rows);

    // ── 4. Volume metrics ───────────────────────────────────────────────────
    const totalRequests = rows.length;
    let totalTokens     = 0;
    let totalCostUSD    = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;
    const paidUserIds   = new Set<string>();

    for (const row of rows) {
      totalTokens     += row.totalTokens;
      totalCostUSD    += row.costUSD;
      totalRevenueUSD += row.revenueUSD;

      if (row.tier === 'free') {
        freeTierCostUSD += row.costUSD;
      } else {
        paidTierCostUSD += row.costUSD;
        paidUserIds.add(row.userId);
      }
    }

    // ── 5. Revenue fallback: if usageLogs has no revenue data yet ───────────
    //    (happens on fresh collection before revenue webhooks populate it)
    const hasRevenueData = rows.some(r => r.revenueUSD > 0);
    let paidUserCount = paidUserIds.size;

    if (!hasRevenueData) {
      const estimated = await estimateRevenueFromUsers(period.startDate, period.endDate);
      totalRevenueUSD = estimated.totalRevenueUSD;
      paidUserCount   = estimated.paidUserCount;
    }

    // ── 6. Margin calculations ───────────────────────────────────────────────
    const grossMarginUSD     = parseFloat((totalRevenueUSD - totalCostUSD).toFixed(6));
    const grossMarginPercent = totalRevenueUSD > 0
      ? parseFloat(((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2))
      : 0;

    // ── 7. Per-unit economics ────────────────────────────────────────────────
    const avgCostPerRequest = totalRequests > 0
      ? parseFloat((totalCostUSD / totalRequests).toFixed(8))
      : 0;

    const avgRevenuePerPaidUser = paidUserCount > 0
      ? parseFloat((totalRevenueUSD / paidUserCount).toFixed(4))
      : 0;

    // ── 8. Feature analytics ─────────────────────────────────────────────────
    const topFeatures    = computeTopFeatures(rows);
    const modelBreakdown = computeModelBreakdown(rows);

    // ── 9. Health alerts ─────────────────────────────────────────────────────
    const healthAlerts = computeHealthAlerts(
      grossMarginPercent,
      freeTierCostUSD,
      totalCostUSD,
    );

    // ── 10. Data source flag ─────────────────────────────────────────────────
    const dataSource = docCount === 0
      ? 'aggregated'
      : capped
        ? 'hybrid'
        : 'live';

    return {
      period:      period.label,
      startDate:   period.startDate.toISOString().split('T')[0],
      endDate:     period.endDate.toISOString().split('T')[0],

      totalUsers,
      activeUsers,

      totalRequests,
      totalTokens,

      totalCostUSD:    parseFloat(totalCostUSD.toFixed(6)),
      totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(4)),
      grossMarginUSD:  parseFloat(grossMarginUSD.toFixed(6)),
      grossMarginPercent,

      freeTierCostUSD: parseFloat(freeTierCostUSD.toFixed(6)),
      paidTierCostUSD: parseFloat(paidTierCostUSD.toFixed(6)),

      avgCostPerRequest,
      avgRevenuePerPaidUser,

      topFeatures,
      modelBreakdown,
      healthAlerts,

      dataSource,
      generatedAt: new Date().toISOString(),
      periodDays:  period.days,

      // Add capped warning to response if limit hit
      ...(capped && {
        _warning: `Query returned ${docCount} docs (limit: 10,000). Data may be incomplete. Use /admin/metrics/aggregated for accurate results over large periods.`,
      }),
    };
  }

  /**
   * getAggregatedMetrics — Read from pre-computed daily aggregates.
   *
   * Uses the metrics/daily/{YYYY-MM-DD} documents written by
   * the DailyMetricsAggregator cron job (see adminMetrics.aggregator.ts).
   *
   * Recommended for periods > 10k docs.
   */
  async getAggregatedMetrics(params: MetricsQueryParams): Promise<Partial<AdminMetricsResponse>> {
    const period = resolvePeriodWindow(params);
    

    const startStr = period.startDate.toISOString().split('T')[0];
    const endStr   = period.endDate.toISOString().split('T')[0];

    const snap = await db
      .collection('metrics')
      .doc('daily')
      .collection('snapshots')
      .where('date', '>=', startStr)
      .where('date', '<=', endStr)
      .orderBy('date', 'asc')
      .get();

    if (snap.empty) {
      return {
        period:     period.label,
        startDate:  startStr,
        endDate:    endStr,
        totalUsers: 0,
        _warning:   'No aggregated data found for this period. Run the daily aggregation job first.',
      } as any;
    }

    // Roll up daily snapshots into period totals
    let totalRequests   = 0;
    let totalTokens     = 0;
    let totalCostUSD    = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;
    let paidUserCount   = 0;
    const featureCounts: Record<string, number> = {};
    const activeUserSet = new Set<string>();

    snap.docs.forEach(doc => {
      const d = doc.data();
      totalRequests   += d.totalRequests   ?? 0;
      totalTokens     += d.totalTokens     ?? 0;
      totalCostUSD    += d.totalCostUSD    ?? 0;
      totalRevenueUSD += d.totalRevenueUSD ?? 0;
      freeTierCostUSD += d.freeTierCostUSD ?? 0;
      paidTierCostUSD += d.paidTierCostUSD ?? 0;
      paidUserCount   += d.paidUserCount   ?? 0;

      // Feature counts — merge
      if (d.featureCounts) {
        for (const [f, c] of Object.entries(d.featureCounts as Record<string, number>)) {
          featureCounts[f] = (featureCounts[f] ?? 0) + c;
        }
      }
    });

    const totalUsers    = await usageLogsRepository.getTotalUserCount();
    const grossMarginUSD = parseFloat((totalRevenueUSD - totalCostUSD).toFixed(6));
    const grossMarginPercent = totalRevenueUSD > 0
      ? parseFloat(((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2))
      : 0;

    const topFeatures = Object.entries(featureCounts)
      .map(([feature, count]) => ({ feature, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      period:      period.label,
      startDate:   startStr,
      endDate:     endStr,
      totalUsers,
      activeUsers: 0, // not tracked in daily agg — use live query for accuracy
      totalRequests,
      totalTokens,
      totalCostUSD:    parseFloat(totalCostUSD.toFixed(6)),
      totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(4)),
      grossMarginUSD,
      grossMarginPercent,
      freeTierCostUSD: parseFloat(freeTierCostUSD.toFixed(6)),
      paidTierCostUSD: parseFloat(paidTierCostUSD.toFixed(6)),
      avgCostPerRequest: totalRequests > 0 ? parseFloat((totalCostUSD / totalRequests).toFixed(8)) : 0,
      avgRevenuePerPaidUser: paidUserCount > 0 ? parseFloat((totalRevenueUSD / paidUserCount).toFixed(4)) : 0,
      topFeatures,
      healthAlerts: computeHealthAlerts(grossMarginPercent, freeTierCostUSD, totalCostUSD),
      dataSource: 'aggregated',
      generatedAt: new Date().toISOString(),
      periodDays: period.days,
    };
  }
}

export const adminMetricsService = new AdminMetricsService();