'use strict';

const supabase   = require('../config/supabase');
const BaseWorker = require('./shared/BaseWorker');
const logger     = require('../utils/logger');

class AdminMetricsAggregator extends BaseWorker {
  constructor() {
    super('admin-metrics');
  }

  async process({ targetDate }) {
    const jobStart = Date.now();
    logger.info('[AdminMetricsAggregator] Start', { targetDate });

    const startISO = `${targetDate}T00:00:00.000Z`;
    const endISO   = `${targetDate}T23:59:59.999Z`;

    // ── Fetch usage logs (SAFE) ────────────────────────────────────────
    let logRows = [];

    try {
      const { data, error } = await supabase
        .from('usage_logs')
        .select(`
          user_id,
          feature,
          tier,
          model,
          input_tokens,
          output_tokens,
          total_tokens,
          cost_usd,
          revenue_usd
        `)
        .gte('created_at', startISO)
        .lte('created_at', endISO);

      if (error) throw error;

      logRows = data || [];
    } catch (err) {
      logger.error('[AdminMetricsAggregator] usage_logs query failed', {
        err: err?.message,
        targetDate
      });
      throw err;
    }

    // ── Map rows ───────────────────────────────────────────────────────
    const rows = logRows.map(d => ({
      userId: d.user_id || '',
      feature: d.feature || 'unknown',
      tier: d.tier || 'free',
      model: d.model || 'unknown',
      inputTokens: d.input_tokens || 0,
      outputTokens: d.output_tokens || 0,
      totalTokens: d.total_tokens || 0,
      costUSD: d.cost_usd || 0,
      revenueUSD: d.revenue_usd || 0,
    }));

    if (rows.length === 0) {
      logger.warn('[AdminMetricsAggregator] No data', { targetDate });
      return {
        date: targetDate,
        docCount: 0,
        durationMs: Date.now() - jobStart
      };
    }

    // ── Aggregation ────────────────────────────────────────────────────
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const featureCounts = {};
    const paidUserIds = new Set();
    const allUserIds = new Set();

    for (const row of rows) {
      totalTokens += row.totalTokens;
      totalCostUSD += row.costUSD;
      totalRevenueUSD += row.revenueUSD;

      if (row.userId) allUserIds.add(row.userId);

      featureCounts[row.feature] = (featureCounts[row.feature] || 0) + 1;

      if (row.tier === 'free') {
        freeTierCostUSD += row.costUSD;
      } else {
        paidTierCostUSD += row.costUSD;
        if (row.userId) paidUserIds.add(row.userId);
      }
    }

    const grossMarginUSD = totalRevenueUSD - totalCostUSD;
    const grossMarginPercent =
      totalRevenueUSD > 0
        ? (grossMarginUSD / totalRevenueUSD) * 100
        : 0;

    // ── Total users (SAFE) ─────────────────────────────────────────────
    let totalUsers = 0;

    try {
      const { count, error } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true });

      if (error) throw error;

      totalUsers = count || 0;
    } catch (err) {
      logger.error('[AdminMetricsAggregator] user count failed', {
        err: err?.message
      });
    }

    // ── Snapshot ───────────────────────────────────────────────────────
    const aggregate = {
      date: targetDate,
      total_users: totalUsers,
      active_users: allUserIds.size,
      total_requests: rows.length,
      total_tokens: totalTokens,
      total_cost_usd: +totalCostUSD.toFixed(6),
      total_revenue_usd: +totalRevenueUSD.toFixed(4),
      gross_margin_usd: +grossMarginUSD.toFixed(6),
      gross_margin_percent: +grossMarginPercent.toFixed(2),
      free_tier_cost_usd: +freeTierCostUSD.toFixed(6),
      paid_tier_cost_usd: +paidTierCostUSD.toFixed(6),
      paid_user_count: paidUserIds.size,
      feature_counts: featureCounts,
      updated_at: new Date().toISOString(),
    };

    // ── Upsert ─────────────────────────────────────────────────────────
    try {
      const { error } = await supabase
        .from('metrics_daily_snapshots')
        .upsert(aggregate, { onConflict: 'date' });

      if (error) throw error;
    } catch (err) {
      logger.error('[AdminMetricsAggregator] snapshot upsert failed', {
        err: err?.message,
        targetDate
      });
      throw err;
    }

    const durationMs = Date.now() - jobStart;

    logger.info('[AdminMetricsAggregator] Done', {
      targetDate,
      rows: rows.length,
      durationMs
    });

    return {
      date: targetDate,
      docCount: rows.length,
      durationMs,
    };
  }

  // ── Runner ──────────────────────────────────────────────────────────

  async runJob(dateStr) {
    const targetDate = dateStr ?? this._yesterdayUTC();

    const idempotencyKey = BaseWorker.buildIdempotencyKey('system', {
      job: 'admin-metrics',
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

// CLI
if (require.main === module) {
  const dateArg = process.argv[2];

  adminMetricsAggregator.runJob(dateArg)
    .then(r => {
      console.log('Done:', r);
      process.exit(0);
    })
    .catch(e => {
      console.error('Failed:', e);
      process.exit(1);
    });
}