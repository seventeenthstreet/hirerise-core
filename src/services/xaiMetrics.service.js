'use strict';

/**
 * src/services/xaiMetrics.service.js
 *
 * WP-13B — XAI Metrics Service
 *
 * Provides live aggregation for the WP-7 dashboard endpoints:
 *   GET /api/v1/metrics/xai-usage
 *   GET /api/v1/metrics/xai-tier
 *
 * Reads from `resume_analyses` (premium_match engine records).
 * No user PII returned — aggregate counts and rates only.
 *
 * Called by xaiMetrics.routes.js to replace Phase 1 zero-value stubs.
 * Frontend hooks (useXaiMetrics, useXaiDashboard) require zero changes.
 */

const { supabase } = require('../config/supabase');
const logger       = require('../utils/logger');

const TABLE          = 'resume_analyses';
const PREMIUM_ENGINE = 'premium_match';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function buildDateFilter(query, filters) {
  if (filters?.date_from) {
    query = query.gte('created_at', filters.date_from);
  }
  if (filters?.date_to) {
    query = query.lte('created_at', filters.date_to);
  }
  return query;
}

function toRate(count, total) {
  if (!total) return 0;
  return Number((count / total).toFixed(4));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET XAI USAGE METRICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates explanation pipeline usage from resume_analyses.
 *
 * @param {object} [filters]
 * @param {string} [filters.date_from]  ISO-8601
 * @param {string} [filters.date_to]    ISO-8601
 * @returns {Promise<XaiUsageMetrics>}
 */
async function getUsageMetrics(filters = {}) {
  try {
    let query = supabase
      .from(TABLE)
      .select('id, cache_hit, latency_ms, operation_type, created_at')
      .eq('engine', PREMIUM_ENGINE);

    query = buildDateFilter(query, filters);

    const { data, error } = await query;

    if (error) {
      logger.warn('[XaiMetricsService] getUsageMetrics query failed', { error: error.message });
      return buildZeroUsageMetrics();
    }

    const rows = data ?? [];
    const total = rows.length;

    if (total === 0) return buildZeroUsageMetrics();

    // Latency percentiles from available records
    const latencies = rows
      .map((r) => Number(r.latency_ms ?? 0))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    const p50 = latencies.length
      ? latencies[Math.floor(latencies.length * 0.5)] ?? 0
      : 0;
    const p95 = latencies.length
      ? latencies[Math.floor(latencies.length * 0.95)] ?? 0
      : 0;

    const cacheHits   = rows.filter((r) => r.cache_hit).length;
    const cacheMisses = total - cacheHits;

    // Treat cache misses as explanation requests, hits as potential fallbacks
    const explanationCount = total;
    // Success = record exists with a latency reading (engine completed)
    const successCount  = rows.filter((r) => (r.latency_ms ?? 0) > 0).length;
    const failureCount  = explanationCount - successCount;
    const fallbackCount = cacheHits; // cache hits bypass fresh AI = fallback-class

    // Breakdown by operation_type
    const typeCounts = {};
    for (const row of rows) {
      const t = row.operation_type ?? 'unknown';
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }

    return {
      explanation_request_count:  explanationCount,
      explanation_success_rate:   toRate(successCount, explanationCount),
      explanation_failure_rate:   toRate(failureCount, explanationCount),
      explanation_p50_ms:         Math.round(p50),
      explanation_p95_ms:         Math.round(p95),
      fallback_explanation_count: fallbackCount,
      explanation_types:          typeCounts,
    };
  } catch (err) {
    logger.error('[XaiMetricsService] getUsageMetrics unexpected error', { error: err.message });
    return buildZeroUsageMetrics();
  }
}

function buildZeroUsageMetrics() {
  return {
    explanation_request_count:  0,
    explanation_success_rate:   0,
    explanation_failure_rate:   0,
    explanation_p50_ms:         0,
    explanation_p95_ms:         0,
    fallback_explanation_count: 0,
    explanation_types:          {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET XAI TIER DISTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates tier distribution from resume_analyses.
 *
 * @param {object} [filters]
 * @returns {Promise<XaiTierDistributionMetrics>}
 */
async function getTierDistribution(filters = {}) {
  try {
    let query = supabase
      .from(TABLE)
      .select('id, tier, created_at')
      .eq('engine', PREMIUM_ENGINE);

    query = buildDateFilter(query, filters);

    const { data, error } = await query;

    if (error) {
      logger.warn('[XaiMetricsService] getTierDistribution query failed', { error: error.message });
      return buildZeroTierMetrics();
    }

    const rows = data ?? [];
    const total = rows.length;

    const distribution = { HIGH: 0, MEDIUM: 0, LOW: 0, NO_DATA: 0 };

    for (const row of rows) {
      const tier = row.tier;
      if (tier && Object.prototype.hasOwnProperty.call(distribution, tier)) {
        distribution[tier]++;
      } else {
        distribution.NO_DATA++;
      }
    }

    // ai_augmentation_exposure_rate = fraction of records that are HIGH or MEDIUM
    const augmented = distribution.HIGH + distribution.MEDIUM;
    const aiAugmentationExposureRate = toRate(augmented, total);

    return {
      tier_distribution:             distribution,
      ai_augmentation_exposure_rate: aiAugmentationExposureRate,
    };
  } catch (err) {
    logger.error('[XaiMetricsService] getTierDistribution unexpected error', { error: err.message });
    return buildZeroTierMetrics();
  }
}

function buildZeroTierMetrics() {
  return {
    tier_distribution: { HIGH: 0, MEDIUM: 0, LOW: 0, NO_DATA: 0 },
    ai_augmentation_exposure_rate: 0,
  };
}

module.exports = { getUsageMetrics, getTierDistribution };
