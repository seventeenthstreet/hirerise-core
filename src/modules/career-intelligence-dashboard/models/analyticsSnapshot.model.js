'use strict';

/**
 * src/modules/analytics/models/analyticsSnapshot.model.js
 *
 * Supabase row model definitions for the
 * Global Career Intelligence Dashboard analytics layer.
 *
 * Tables:
 * - gcid_analytics_snapshots
 * - gcid_aggregated_cache
 *
 * This file provides:
 * - table constants
 * - enum-safe metric constants
 * - supported region constants
 * - row builders for inserts/upserts
 * - safe normalization helpers
 */

const TABLES = Object.freeze({
  SNAPSHOTS: 'gcid_analytics_snapshots',
  AGGREGATED_CACHE: 'gcid_aggregated_cache',
});

const METRIC_NAMES = Object.freeze({
  CAREER_DEMAND: 'career_demand',
  SKILL_DEMAND: 'skill_demand',
  EDUCATION_ROI: 'education_roi',
  CAREER_GROWTH: 'career_growth',
  INDUSTRY_TRENDS: 'industry_trends',
});

const REGIONS = Object.freeze(['global', 'india', 'us', 'uk', 'uae']);

const DEFAULT_REGION = 'india';
const DEFAULT_CACHE_TTL_SECONDS = 3600;

/**
 * Returns YYYY-MM-DD in UTC
 * @returns {string}
 */
function getCurrentSnapshotDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Validate supported metric name
 * @param {string} metricName
 * @returns {string}
 */
function normalizeMetricName(metricName) {
  if (!metricName || typeof metricName !== 'string') {
    throw new Error('metric_name is required');
  }

  const normalized = metricName.trim().toLowerCase();

  if (!Object.values(METRIC_NAMES).includes(normalized)) {
    throw new Error(`Invalid metric_name: ${metricName}`);
  }

  return normalized;
}

/**
 * Validate supported region
 * @param {string | undefined} region
 * @returns {string}
 */
function normalizeRegion(region) {
  const normalized = (region || DEFAULT_REGION).trim().toLowerCase();

  if (!REGIONS.includes(normalized)) {
    return DEFAULT_REGION;
  }

  return normalized;
}

/**
 * Build row for gcid_analytics_snapshots insert
 *
 * Expected SQL columns:
 * - metric_name TEXT
 * - metric_value JSONB
 * - region TEXT
 * - snapshot_date DATE
 *
 * created_at should be DB default now()
 *
 * @param {Object} fields
 * @returns {Object}
 */
function buildSnapshotRow(fields = {}) {
  return {
    metric_name: normalizeMetricName(fields.metric_name),
    metric_value: fields.metric_value ?? {},
    region: normalizeRegion(fields.region),
    snapshot_date: fields.snapshot_date || getCurrentSnapshotDate(),
  };
}

/**
 * Build row for gcid_aggregated_cache upsert
 *
 * Expected SQL columns:
 * - metric_name TEXT PRIMARY KEY
 * - data JSONB
 * - ttl_seconds INTEGER
 *
 * computed_at should be DB default now()
 *
 * @param {string} metricName
 * @param {*} data
 * @param {number} ttlSeconds
 * @returns {Object}
 */
function buildCacheRow(metricName, data, ttlSeconds = DEFAULT_CACHE_TTL_SECONDS) {
  return {
    metric_name: normalizeMetricName(metricName),
    data: data ?? {},
    ttl_seconds: Number.isFinite(ttlSeconds)
      ? ttlSeconds
      : DEFAULT_CACHE_TTL_SECONDS,
  };
}

module.exports = Object.freeze({
  TABLES,
  METRIC_NAMES,
  REGIONS,
  DEFAULT_REGION,
  DEFAULT_CACHE_TTL_SECONDS,
  getCurrentSnapshotDate,
  normalizeMetricName,
  normalizeRegion,
  buildSnapshotRow,
  buildCacheRow,
});