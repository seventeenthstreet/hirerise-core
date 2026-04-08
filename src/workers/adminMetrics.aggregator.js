'use strict';

const supabase = require('../config/supabase');
const BaseWorker = require('./shared/BaseWorker');
const logger = require('../utils/logger');

const WORKER_NAME = 'admin-metrics';
const SNAPSHOT_TABLE = 'metrics_daily_snapshots';
const USAGE_LOGS_TABLE = 'usage_logs';
const USERS_TABLE = 'users';

class AdminMetricsAggregator extends BaseWorker {
  constructor() {
    super(WORKER_NAME);
  }

  async process({ targetDate }) {
    const startedAt = Date.now();
    logger.info('[AdminMetricsAggregator] Start', { targetDate });

    const { startISO, endISO } = this._buildUtcDayRange(targetDate);

    const [usageRows, totalUsers] = await Promise.all([
      this._fetchUsageLogs(startISO, endISO, targetDate),
      this._fetchTotalUsers()
    ]);

    if (usageRows.length === 0) {
      logger.warn('[AdminMetricsAggregator] No usage data found', {
        targetDate
      });

      return {
        date: targetDate,
        docCount: 0,
        durationMs: Date.now() - startedAt
      };
    }

    const aggregate = this._buildAggregateSnapshot(
      usageRows,
      totalUsers,
      targetDate
    );

    await this._upsertSnapshot(aggregate, targetDate);

    const durationMs = Date.now() - startedAt;

    logger.info('[AdminMetricsAggregator] Done', {
      targetDate,
      rows: usageRows.length,
      durationMs
    });

    return {
      date: targetDate,
      docCount: usageRows.length,
      durationMs
    };
  }

  async runJob(dateStr) {
    const targetDate = dateStr ?? this._yesterdayUTC();

    const idempotencyKey = BaseWorker.buildIdempotencyKey('system', {
      job: WORKER_NAME,
      date: targetDate
    });

    const { result } = await this.run({ targetDate }, idempotencyKey);
    return result;
  }

  async _fetchUsageLogs(startISO, endISO, targetDate) {
    try {
      const { data, error } = await supabase
        .from(USAGE_LOGS_TABLE)
        .select(`
          user_id,
          feature,
          tier,
          total_tokens,
          cost_usd,
          revenue_usd
        `)
        .gte('created_at', startISO)
        .lt('created_at', endISO);

      if (error) throw error;

      return Array.isArray(data) ? data : [];
    } catch (error) {
      logger.error('[AdminMetricsAggregator] usage_logs query failed', {
        targetDate,
        error: error?.message
      });
      throw error;
    }
  }

  async _fetchTotalUsers() {
    try {
      const { count, error } = await supabase
        .from(USERS_TABLE)
        .select('id', { count: 'exact', head: true });

      if (error) throw error;

      return Number(count) || 0;
    } catch (error) {
      logger.error('[AdminMetricsAggregator] user count failed', {
        error: error?.message
      });

      return 0;
    }
  }

  _buildAggregateSnapshot(rows, totalUsers, targetDate) {
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const featureCounts = Object.create(null);
    const paidUserIds = new Set();
    const activeUserIds = new Set();

    for (const row of rows) {
      const userId = row.user_id ?? '';
      const feature = row.feature ?? 'unknown';
      const tier = row.tier ?? 'free';
      const totalTokensRow = Number(row.total_tokens) || 0;
      const costUSD = Number(row.cost_usd) || 0;
      const revenueUSD = Number(row.revenue_usd) || 0;

      totalTokens += totalTokensRow;
      totalCostUSD += costUSD;
      totalRevenueUSD += revenueUSD;

      if (userId) activeUserIds.add(userId);

      featureCounts[feature] = (featureCounts[feature] || 0) + 1;

      if (tier === 'free') {
        freeTierCostUSD += costUSD;
      } else {
        paidTierCostUSD += costUSD;
        if (userId) paidUserIds.add(userId);
      }
    }

    const grossMarginUSD = totalRevenueUSD - totalCostUSD;
    const grossMarginPercent =
      totalRevenueUSD > 0
        ? (grossMarginUSD / totalRevenueUSD) * 100
        : 0;

    return {
      date: targetDate,
      total_users: totalUsers,
      active_users: activeUserIds.size,
      total_requests: rows.length,
      total_tokens: totalTokens,
      total_cost_usd: Number(totalCostUSD.toFixed(6)),
      total_revenue_usd: Number(totalRevenueUSD.toFixed(6)),
      gross_margin_usd: Number(grossMarginUSD.toFixed(6)),
      gross_margin_percent: Number(grossMarginPercent.toFixed(2)),
      free_tier_cost_usd: Number(freeTierCostUSD.toFixed(6)),
      paid_tier_cost_usd: Number(paidTierCostUSD.toFixed(6)),
      paid_user_count: paidUserIds.size,
      feature_counts: featureCounts,
      updated_at: new Date().toISOString()
    };
  }

  async _upsertSnapshot(snapshot, targetDate) {
    try {
      const { error } = await supabase
        .from(SNAPSHOT_TABLE)
        .upsert(snapshot, {
          onConflict: 'date',
          ignoreDuplicates: false
        });

      if (error) throw error;
    } catch (error) {
      logger.error('[AdminMetricsAggregator] snapshot upsert failed', {
        targetDate,
        error: error?.message
      });
      throw error;
    }
  }

  _buildUtcDayRange(date) {
    const startISO = `${date}T00:00:00.000Z`;

    const nextDay = new Date(`${date}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    return {
      startISO,
      endISO: nextDay.toISOString()
    };
  }

  _yesterdayUTC() {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
}

const adminMetricsAggregator = new AdminMetricsAggregator();

module.exports = {
  adminMetricsAggregator
};

if (require.main === module) {
  const dateArg = process.argv[2];

  adminMetricsAggregator
    .runJob(dateArg)
    .then(result => {
      logger.info('[AdminMetricsAggregator] CLI success', result);
      process.exit(0);
    })
    .catch(error => {
      logger.error('[AdminMetricsAggregator] CLI failed', {
        error: error?.message
      });
      process.exit(1);
    });
}