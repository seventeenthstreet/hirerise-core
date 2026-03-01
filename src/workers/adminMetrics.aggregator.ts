'use strict';
/**
 * adminMetrics.aggregator.ts
 *
 * Nightly cron job that pre-aggregates usageLogs → metrics/daily/{YYYY-MM-DD}
 *
 * WHY THIS EXISTS:
 *   At scale (>10k daily requests), querying usageLogs directly is expensive.
 *   This worker runs nightly and writes compact daily snapshots that the
 *   /admin/metrics endpoint can read in a single efficient query.
 *
 * SCHEDULE: 1am UTC daily (aligns with existing daily-aggregation.worker.js)
 *
 * DEPLOYMENT OPTIONS:
 *   A) Cloud Scheduler → POST /admin/ai/aggregate (already wired in codebase)
 *   B) node-cron in main process (same pattern as existing sla-evaluation.worker.js)
 *   C) Add to existing DailyAggregationWorker.runJob()
 *
 * IDEMPOTENT: Safe to re-run for same date — uses Firestore merge.
 *
 * FIRESTORE PATH: metrics/daily/snapshots/{YYYY-MM-DD}
 */

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { DailyMetricsAggregate, CostRow } from '../types/metrics.types';

const COLLECTION_PATH = {
  usageLogs: 'usageLogs',
  snapshots: (date: string) =>
    getFirestore().collection('metrics').doc('daily').collection('snapshots').doc(date),
};

class AdminMetricsAggregator {

  /**
   * runJob — Aggregate metrics for a specific date.
   *
   * @param dateStr - 'YYYY-MM-DD', defaults to yesterday UTC
   */
  async runJob(dateStr?: string): Promise<{ date: string; docCount: number; durationMs: number }> {
    const targetDate = dateStr ?? this._yesterdayUTC();
    const jobStart   = Date.now();

    console.log(`[AdminMetricsAggregator] Starting for ${targetDate}`);

    // ── 1. Fetch all usageLogs for the target date ───────────────────────────
    const db        = getFirestore();
    const startDate = new Date(`${targetDate}T00:00:00.000Z`);
    const endDate   = new Date(`${targetDate}T23:59:59.999Z`);

    const snap = await db
      .collection(COLLECTION_PATH.usageLogs)
      .where('createdAt', '>=', Timestamp.fromDate(startDate))
      .where('createdAt', '<=', Timestamp.fromDate(endDate))
      .get();

    const rows: CostRow[] = snap.docs.map(d => {
      const data = d.data();
      return {
        userId:       data.userId       ?? '',
        feature:      data.feature      ?? 'unknown',
        tier:         data.tier         ?? 'free',
        model:        data.model        ?? 'unknown',
        inputTokens:  data.inputTokens  ?? 0,
        outputTokens: data.outputTokens ?? 0,
        totalTokens:  data.totalTokens  ?? 0,
        costUSD:      data.costUSD      ?? 0,
        revenueUSD:   data.revenueUSD   ?? 0,
        date:         targetDate,
      };
    });

    if (rows.length === 0) {
      console.log(`[AdminMetricsAggregator] No data for ${targetDate} — skipping`);
      return { date: targetDate, docCount: 0, durationMs: Date.now() - jobStart };
    }

    // ── 2. Compute aggregate ─────────────────────────────────────────────────
    let totalRequests   = rows.length;
    let totalTokens     = 0;
    let totalCostUSD    = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;
    const featureCounts: Record<string, number> = {};
    const paidUserIds   = new Set<string>();
    const allUserIds    = new Set<string>();

    for (const row of rows) {
      totalTokens     += row.totalTokens;
      totalCostUSD    += row.costUSD;
      totalRevenueUSD += row.revenueUSD;
      allUserIds.add(row.userId);

      featureCounts[row.feature] = (featureCounts[row.feature] ?? 0) + 1;

      if (row.tier === 'free') {
        freeTierCostUSD += row.costUSD;
      } else {
        paidTierCostUSD += row.costUSD;
        paidUserIds.add(row.userId);
      }
    }

    const grossMarginUSD     = totalRevenueUSD - totalCostUSD;
    const grossMarginPercent = totalRevenueUSD > 0
      ? parseFloat(((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2))
      : 0;

    const totalUsersSnap = await db.collection('users').count().get();

    const aggregate: DailyMetricsAggregate = {
      date:                targetDate,
      totalUsers:          totalUsersSnap.data().count,
      activeUsers:         allUserIds.size,
      totalRequests,
      totalTokens,
      totalCostUSD:        parseFloat(totalCostUSD.toFixed(6)),
      totalRevenueUSD:     parseFloat(totalRevenueUSD.toFixed(4)),
      grossMarginUSD:      parseFloat(grossMarginUSD.toFixed(6)),
      grossMarginPercent,
      freeTierCostUSD:     parseFloat(freeTierCostUSD.toFixed(6)),
      paidTierCostUSD:     parseFloat(paidTierCostUSD.toFixed(6)),
      paidUserCount:       paidUserIds.size,
      featureCounts,
      updatedAt:           FieldValue.serverTimestamp() as any,
    };

    // ── 3. Write to Firestore (idempotent merge) ──────────────────────────────
    await COLLECTION_PATH.snapshots(targetDate).set(aggregate, { merge: true });

    const durationMs = Date.now() - jobStart;
    console.log(`[AdminMetricsAggregator] Done for ${targetDate} — ${rows.length} docs in ${durationMs}ms`);

    return { date: targetDate, docCount: rows.length, durationMs };
  }

  private _yesterdayUTC(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
}

export const adminMetricsAggregator = new AdminMetricsAggregator();

// ─── CLI entry point ──────────────────────────────────────────────────────────
// node dist/workers/adminMetrics.aggregator.js [YYYY-MM-DD]
if (require.main === module) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();

  const dateArg = process.argv[2] ?? undefined;
  adminMetricsAggregator
    .runJob(dateArg)
    .then(r  => { console.log('Done:', r); process.exit(0); })
    .catch(e => { console.error('Failed:', e); process.exit(1); });
}