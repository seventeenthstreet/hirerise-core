'use strict';

/**
 * adminMetrics.aggregator.js
 *
 * MIGRATION: Removed require('../config/supabase'). All DB access now uses
 * the direct Supabase client via config/supabase. The shim's db.collection()
 * / Timestamp / FieldValue calls are replaced with native supabase.from() queries.
 *
 * Query changes:
 *
 *   OLD: db.collection('usageLogs')
 *          .where('createdAt', '>=', Timestamp.fromDate(startDate))
 *          .where('createdAt', '<=', Timestamp.fromDate(endDate))
 *          .get()
 *   NEW: supabase.from('usage_logs').select('*')
 *          .gte('created_at', startISO).lte('created_at', endISO)
 *
 *   OLD: db.collection('users').count().get() → snap.data().count
 *   NEW: supabase.from('users').select('*', { count: 'exact', head: true })
 *        → count field on the response
 *
 *   OLD: db.collection('metrics').doc('daily').collection('snapshots').doc(date).set(...)
 *   NEW: supabase.from('metrics_daily_snapshots').upsert({ date, ...aggregate })
 *
 *   OLD: FieldValue.serverTimestamp()
 *   NEW: new Date().toISOString()
 *
 * Schema assumptions:
 *   usage_logs           — columns: created_at, user_id, feature, tier, model,
 *                          input_tokens, output_tokens, total_tokens, cost_usd, revenue_usd
 *   metrics_daily_snapshots — columns: date (PK), total_users, active_users, ...
 */

const supabase   = require('../config/supabase');
const BaseWorker = require('./shared/BaseWorker');

class AdminMetricsAggregator extends BaseWorker {
  constructor() {
    super('admin-metrics');
  }

  /**
   * Core aggregation logic — called by BaseWorker.run() after idempotency check.
   *
   * @param {{ targetDate: string }} payload  — e.g. { targetDate: '2025-01-15' }
   * @returns {Promise<{ date: string, docCount: number, durationMs: number }>}
   */
  async process({ targetDate }) {
    const jobStart = Date.now();
    console.log(`[AdminMetricsAggregator] Starting for ${targetDate}`);

    const startISO = `${targetDate}T00:00:00.000Z`;
    const endISO   = `${targetDate}T23:59:59.999Z`;

    // ── Fetch usage logs for target date ────────────────────────────────────
    const { data: logRows, error: logErr } = await supabase
      .from('usage_logs')
      .select('*')
      .gte('created_at', startISO)
      .lte('created_at', endISO);

    if (logErr) throw new Error(`[AdminMetricsAggregator] usage_logs query failed: ${logErr.message}`);

    const rows = (logRows ?? []).map(d => ({
      user_id:       d.user_id       ?? '',
      feature:      d.feature       ?? 'unknown',
      tier:         d.tier          ?? 'free',
      model:        d.model         ?? 'unknown',
      inputTokens:  d.input_tokens  ?? 0,
      outputTokens: d.output_tokens ?? 0,
      totalTokens:  d.total_tokens  ?? 0,
      costUSD:      d.cost_usd      ?? 0,
      revenueUSD:   d.revenue_usd   ?? 0,
      date:         targetDate,
    }));

    if (rows.length === 0) {
      console.log(`[AdminMetricsAggregator] No data for ${targetDate} — skipping`);
      return { date: targetDate, docCount: 0, durationMs: Date.now() - jobStart };
    }

    // ── Aggregate ───────────────────────────────────────────────────────────
    let totalRequests   = rows.length;
    let totalTokens     = 0;
    let totalCostUSD    = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const featureCounts = {};
    const paidUserIds   = new Set();
    const allUserIds    = new Set();

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

    // ── Count total users ───────────────────────────────────────────────────
    const { count: totalUsers, error: countErr } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (countErr) throw new Error(`[AdminMetricsAggregator] user count query failed: ${countErr.message}`);

    // ── Upsert daily snapshot ───────────────────────────────────────────────
    const aggregate = {
      date:                targetDate,
      total_users:         totalUsers ?? 0,
      active_users:        allUserIds.size,
      total_requests:      totalRequests,
      total_tokens:        totalTokens,
      total_cost_usd:      parseFloat(totalCostUSD.toFixed(6)),
      total_revenue_usd:   parseFloat(totalRevenueUSD.toFixed(4)),
      gross_margin_usd:    parseFloat(grossMarginUSD.toFixed(6)),
      gross_margin_percent: grossMarginPercent,
      free_tier_cost_usd:  parseFloat(freeTierCostUSD.toFixed(6)),
      paid_tier_cost_usd:  parseFloat(paidTierCostUSD.toFixed(6)),
      paid_user_count:     paidUserIds.size,
      feature_counts:      featureCounts,
      updated_at:          new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('metrics_daily_snapshots')
      .upsert(aggregate, { onConflict: 'date' });

    if (upsertErr) {
      throw new Error(`[AdminMetricsAggregator] Snapshot upsert failed: ${upsertErr.message}`);
    }

    const durationMs = Date.now() - jobStart;
    console.log(`[AdminMetricsAggregator] Done for ${targetDate} — ${rows.length} docs in ${durationMs}ms`);
    return { date: targetDate, docCount: rows.length, durationMs };
  }

  /**
   * Backward-compatible wrapper. Existing call sites use runJob(dateStr) unchanged.
   *
   * @param {string=} dateStr  — YYYY-MM-DD, defaults to yesterday UTC
   */
  async runJob(dateStr) {
    const targetDate = dateStr ?? this._yesterdayUTC();

    const idempotencyKey = BaseWorker.buildIdempotencyKey('system', {
      job:  'admin-metrics',
      date: targetDate,
    });

    const { result } = await this.run({ targetDate }, idempotencyKey);
    return result;
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
  const dateArg = process.argv[2] ?? undefined;
  adminMetricsAggregator.runJob(dateArg)
    .then(r  => { console.log('Done:', r); process.exit(0); })
    .catch(e => { console.error('Failed:', e); process.exit(1); });
}








