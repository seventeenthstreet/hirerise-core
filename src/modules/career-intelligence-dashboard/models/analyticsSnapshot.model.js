'use strict';

/**
 * models/analyticsSnapshot.model.js
 *
 * Firestore collection for the Global Career Intelligence Dashboard.
 *
 * Collection: gcid_analytics_snapshots
 *   Stores point-in-time snapshots of every computed metric.
 *   One document per (metric_name, region, snapshot_date) — allows
 *   trend lines to be built by querying across timestamps.
 *
 * Collection: gcid_aggregated_cache
 *   Single document per metric type — the latest computed aggregate,
 *   served directly by the API without re-computation on every request.
 */

const COLLECTIONS = {
  SNAPSHOTS:        'gcid_analytics_snapshots',
  AGGREGATED_CACHE: 'gcid_aggregated_cache',
};

// Metric name constants — single source of truth used by service + controller
const METRIC_NAMES = {
  CAREER_DEMAND:    'career_demand',
  SKILL_DEMAND:     'skill_demand',
  EDUCATION_ROI:    'education_roi',
  CAREER_GROWTH:    'career_growth',
  INDUSTRY_TRENDS:  'industry_trends',
};

const REGIONS = ['global', 'india', 'us', 'uk', 'uae'];

/**
 * gcid_analytics_snapshots/{autoId}
 *
 *   id            — auto Firestore ID
 *   metric_name   — METRIC_NAMES value
 *   metric_value  — JSON-serialisable payload (the full computed result)
 *   region        — REGIONS value (default 'india')
 *   snapshot_date — ISO date string YYYY-MM-DD
 *   created_at    — serverTimestamp
 */
function buildSnapshotDoc(fields) {
  return {
    metric_name:   fields.metric_name   || null,
    metric_value:  fields.metric_value  || null,
    region:        fields.region        || 'india',
    snapshot_date: fields.snapshot_date || new Date().toISOString().slice(0, 10),
    created_at:    null, // set by service via FieldValue.serverTimestamp()
  };
}

/**
 * gcid_aggregated_cache/{metric_name}  (doc ID = metric_name — one per metric)
 *
 *   metric_name   — string
 *   data          — the full latest computed result object
 *   computed_at   — serverTimestamp
 *   ttl_seconds   — number (how long callers should treat this as fresh)
 */
function buildCacheDoc(metricName, data) {
  return {
    metric_name: metricName,
    data,
    computed_at: null, // set by service
    ttl_seconds: 3600, // 1 hour default
  };
}

module.exports = {
  COLLECTIONS,
  METRIC_NAMES,
  REGIONS,
  buildSnapshotDoc,
  buildCacheDoc,
};









