'use strict';

/**
 * adminMetrics.aggregator.js
 * Converted from adminMetrics.aggregator.ts
 */

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

class AdminMetricsAggregator {
  async runJob(dateStr) {
    const targetDate = dateStr ?? this._yesterdayUTC();
    const jobStart   = Date.now();
    console.log(`[AdminMetricsAggregator] Starting for ${targetDate}`);

    const db        = getFirestore();
    const startDate = new Date(`${targetDate}T00:00:00.000Z`);
    const endDate   = new Date(`${targetDate}T23:59:59.999Z`);

    const snap = await db.collection('usageLogs')
      .where('createdAt', '>=', Timestamp.fromDate(startDate))
      .where('createdAt', '<=', Timestamp.fromDate(endDate))
      .get();

    const rows = snap.docs.map(d => {
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

    let totalRequests = rows.length, totalTokens = 0, totalCostUSD = 0, totalRevenueUSD = 0, freeTierCostUSD = 0, paidTierCostUSD = 0;
    const featureCounts = {}, paidUserIds = new Set(), allUserIds = new Set();

    for (const row of rows) {
      totalTokens     += row.totalTokens;
      totalCostUSD    += row.costUSD;
      totalRevenueUSD += row.revenueUSD;
      allUserIds.add(row.userId);
      featureCounts[row.feature] = (featureCounts[row.feature] ?? 0) + 1;
      if (row.tier === 'free') { freeTierCostUSD += row.costUSD; }
      else { paidTierCostUSD += row.costUSD; paidUserIds.add(row.userId); }
    }

    const grossMarginUSD     = totalRevenueUSD - totalCostUSD;
    const grossMarginPercent = totalRevenueUSD > 0 ? parseFloat(((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2)) : 0;
    const totalUsersSnap     = await db.collection('users').count().get();

    const aggregate = {
      date: targetDate,
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
      updatedAt:           FieldValue.serverTimestamp(),
    };

    await db.collection('metrics').doc('daily').collection('snapshots').doc(targetDate).set(aggregate, { merge: true });

    const durationMs = Date.now() - jobStart;
    console.log(`[AdminMetricsAggregator] Done for ${targetDate} — ${rows.length} docs in ${durationMs}ms`);
    return { date: targetDate, docCount: rows.length, durationMs };
  }

  _yesterdayUTC() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
}

const adminMetricsAggregator = new AdminMetricsAggregator();
module.exports = { adminMetricsAggregator };

// CLI entry point: node src/workers/adminMetrics.aggregator.js [YYYY-MM-DD]
if (require.main === module) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  const dateArg = process.argv[2] ?? undefined;
  adminMetricsAggregator.runJob(dateArg)
    .then(r  => { console.log('Done:', r); process.exit(0); })
    .catch(e => { console.error('Failed:', e); process.exit(1); });
}