'use strict';

/**
 * dailyMetrics.job.js (PRODUCTION READY)
 *
 * - Uses DB-side aggregation (fast, scalable)
 * - Idempotent (safe to rerun)
 * - Minimal memory usage
 */

const { supabase } = require('../config/supabase');

// ─────────────────────────────────────────────
// 🔹 MAIN
// ─────────────────────────────────────────────

async function runDailyAggregation(date = null) {
  try {
    const targetDate = date || new Date();
    const dateStr = targetDate.toISOString().split('T')[0];

    const start = `${dateStr}T00:00:00.000Z`;
    const end   = `${dateStr}T23:59:59.999Z`;

    console.log('[Aggregation] Running for:', dateStr);

    // ─────────────────────────────────────────
    // 1. AGGREGATE (DB SIDE)
    // ─────────────────────────────────────────

    const { data: agg, error } = await supabase.rpc('aggregate_daily_metrics', {
      start_date: start,
      end_date: end
    });

    if (error) throw error;

    if (!agg || agg.length === 0) {
      console.log('[Aggregation] No data found:', dateStr);
      return;
    }

    const result = agg[0];

    // ─────────────────────────────────────────
    // 2. TOTAL USERS
    // ─────────────────────────────────────────

    const { count: total_users, error: userErr } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (userErr) throw userErr;

    // ─────────────────────────────────────────
    // 3. UPSERT SNAPSHOT
    // ─────────────────────────────────────────

    const payload = {
      date: dateStr,
      total_users: total_users || 0,
      active_users: result.active_users || 0,
      total_requests: result.total_requests || 0,
      total_tokens: result.total_tokens || 0,
      total_cost_usd: result.total_cost_usd || 0,
      total_revenue_usd: result.total_revenue_usd || 0,
      gross_margin_usd: result.gross_margin_usd || 0,
      gross_margin_percent: result.gross_margin_percent || 0,
      free_tier_cost_usd: result.free_tier_cost_usd || 0,
      paid_tier_cost_usd: result.paid_tier_cost_usd || 0,
      paid_user_count: result.paid_user_count || 0,
      feature_counts: result.feature_counts || {},
      updated_at: new Date().toISOString()
    };

    const { error: upsertError } = await supabase
      .from('metrics_daily_snapshots')
      .upsert(payload, { onConflict: 'date' });

    if (upsertError) throw upsertError;

    console.log('[Aggregation] Success:', dateStr);

  } catch (err) {
    console.error('[Aggregation] FAILED:', err.message);
    throw err;
  }
}

module.exports = {
  runDailyAggregation
};