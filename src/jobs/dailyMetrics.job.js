'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const AGGREGATE_RPC = 'aggregate_daily_metrics';
const SNAPSHOT_TABLE = 'metrics_daily_snapshots';

function normalizeAggregationResult(agg) {
  if (!agg) return null;
  if (Array.isArray(agg)) return normalizeAggregationResult(agg[0]);
  if (typeof agg !== 'object') return null;

  return {
    active_users: safeNumber(agg.active_users, 0),
    total_requests: safeNumber(agg.total_requests, 0),
    total_tokens: safeNumber(agg.total_tokens, 0),
    total_cost_usd: safeNumber(agg.total_cost_usd, 0),
    total_revenue_usd: safeNumber(agg.total_revenue_usd, 0),
    gross_margin_usd: safeNumber(agg.gross_margin_usd, 0),
    gross_margin_percent: safeNumber(agg.gross_margin_percent, 0),
    free_tier_cost_usd: safeNumber(agg.free_tier_cost_usd, 0),
    paid_tier_cost_usd: safeNumber(agg.paid_tier_cost_usd, 0),
    paid_user_count: safeNumber(agg.paid_user_count, 0),
    feature_counts:
      agg.feature_counts && typeof agg.feature_counts === 'object'
        ? agg.feature_counts
        : {},
  };
}

async function runDailyAggregation(date = null) {
  const targetDate = safeDate(date);

  try {
    const startDate = new Date(
      Date.UTC(
        targetDate.getUTCFullYear(),
        targetDate.getUTCMonth(),
        targetDate.getUTCDate(),
        0,
        0,
        0,
        0
      )
    );

    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 1);

    const dateStr = startDate.toISOString().split('T')[0];

    logger.info('[Aggregation] Running', { date: dateStr });

    const result = await getAggregatedMetrics(startDate, endDate);

    if (!result) {
      logger.info('[Aggregation] No data found', { date: dateStr });
      return {
        date: dateStr,
        updated: false,
        reason: 'no_data',
      };
    }

    const totalUsers = await getTotalUsersCount();

    const payload = {
      date: dateStr,
      total_users: totalUsers,
      ...result,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await supabase
      .from(SNAPSHOT_TABLE)
      .upsert(payload, { onConflict: 'date' });

    if (upsertError) throw upsertError;

    logger.info('[Aggregation] Success', { date: dateStr });

    return {
      date: dateStr,
      updated: true,
      snapshot: payload,
    };
  } catch (err) {
    logger.error('[Aggregation] FAILED', {
      rpc: AGGREGATE_RPC,
      error: err.message,
      code: err.code,
    });
    throw err;
  }
}

async function getAggregatedMetrics(startDate, endDate) {
  try {
    const { data, error } = await supabase.rpc(AGGREGATE_RPC, {
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
    });

    if (error) throw error;
    return normalizeAggregationResult(data);
  } catch (err) {
    if (isRpcDrift(err)) {
      logger.warn('[Aggregation] RPC drift fallback', {
        rpc: AGGREGATE_RPC,
        code: err.code,
        error: err.message,
      });

      return fallbackAggregateFromLogs(startDate, endDate);
    }

    throw err;
  }
}

async function fallbackAggregateFromLogs(startDate, endDate) {
  const { data, error } = await supabase
    .from('ai_logs')
    .select('user_id, total_tokens, total_cost_usd, feature')
    .gte('created_at', startDate.toISOString())
    .lt('created_at', endDate.toISOString())
    .eq('is_deleted', false);

  if (error) throw error;

  const rows = data || [];
  if (!rows.length) return null;

  const activeUsers = new Set();
  const featureCounts = {};

  let totalRequests = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const row of rows) {
    totalRequests += 1;
    totalTokens += safeNumber(row.total_tokens, 0);
    totalCost += safeNumber(row.total_cost_usd, 0);

    if (row.user_id) activeUsers.add(row.user_id);
    if (row.feature) {
      featureCounts[row.feature] =
        safeNumber(featureCounts[row.feature], 0) + 1;
    }
  }

  return normalizeAggregationResult({
    active_users: activeUsers.size,
    total_requests: totalRequests,
    total_tokens: totalTokens,
    total_cost_usd: totalCost,
    total_revenue_usd: 0,
    gross_margin_usd: 0,
    gross_margin_percent: 0,
    free_tier_cost_usd: totalCost,
    paid_tier_cost_usd: 0,
    paid_user_count: 0,
    feature_counts: featureCounts,
  });
}

async function getTotalUsersCount() {
  const { count, error } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });

  if (error) throw error;
  return safeNumber(count, 0);
}

function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeDate(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function isRpcDrift(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    error?.code === '42883' ||
    msg.includes('function') ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  );
}

module.exports = {
  runDailyAggregation,
};