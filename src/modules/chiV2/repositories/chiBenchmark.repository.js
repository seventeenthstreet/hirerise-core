'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

/**
 * Latest benchmark snapshot for one user.
 * Queries the chi_cohort_benchmark_mv materialised view.
 *
 * @param {string} userId — Supabase user UUID
 * @returns {object|null} Latest benchmark row, or null if none exists
 */
async function getLatestBenchmarkByUser(userId) {
  const { data, error } = await supabase
    .from('chi_cohort_benchmark_mv')
    .select(`
      week_bucket,
      avg_score,
      percentile_rank,
      cohort_rank,
      cohort_size,
      cohort_median,
      cohort_p90,
      delta_vs_median,
      delta_vs_top10,
      cohort_key
    `)
    .eq('user_id', userId)
    .order('week_bucket', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('[chiBenchmark.repository] getLatestBenchmarkByUser failed', {
      userId,
      error: error.message,
    });
    throw error;
  }

  return data; // null when no benchmark exists yet — caller handles gracefully
}

/**
 * Historical percentile movement for a user (newest first).
 * Used to render trend charts in the CHI dashboard.
 *
 * @param {string} userId  — Supabase user UUID
 * @param {number} limit   — Number of weekly buckets to return (default: 8)
 * @returns {object[]} Array of benchmark rows, empty array if none
 */
async function getBenchmarkTrend(userId, limit = 8) {
  const { data, error } = await supabase
    .from('chi_cohort_benchmark_mv')
    .select(`
      week_bucket,
      avg_score,
      percentile_rank,
      cohort_rank,
      delta_vs_median
    `)
    .eq('user_id', userId)
    .order('week_bucket', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('[chiBenchmark.repository] getBenchmarkTrend failed', {
      userId,
      limit,
      error: error.message,
    });
    throw error;
  }

  return data || [];
}

module.exports = {
  getLatestBenchmarkByUser,
  getBenchmarkTrend,
};