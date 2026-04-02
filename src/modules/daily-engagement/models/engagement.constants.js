'use strict';

/**
 * modules/daily-engagement/models/engagement.constants.js
 *
 * Single source of truth for:
 * - queue events
 * - DB-safe enum values
 * - cache namespaces
 * - retention policy
 * - daily limits
 *
 * Supabase-ready:
 * - cache key versioning
 * - safe env parsing
 * - stronger immutability
 * - SQL enum alignment
 */

/**
 * Safe positive integer env parser.
 */
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue event contracts
// ─────────────────────────────────────────────────────────────────────────────

const ENGAGEMENT_EVENTS = Object.freeze({
  CV_PARSED: 'CV_PARSED',
  SKILL_GAP_UPDATED: 'SKILL_GAP_UPDATED',
  NEW_JOB_MATCH: 'NEW_JOB_MATCH',
  MARKET_TREND_UPDATED: 'MARKET_TREND_UPDATED',
  OPPORTUNITY_DETECTED: 'OPPORTUNITY_DETECTED',
});

// ─────────────────────────────────────────────────────────────────────────────
// DB-safe enums
// ─────────────────────────────────────────────────────────────────────────────

const INSIGHT_TYPES = Object.freeze({
  SKILL_DEMAND: 'skill_demand',
  JOB_MATCH: 'job_match',
  MARKET_TREND: 'market_trend',
  OPPORTUNITY_SIGNAL: 'opportunity_signal',
  RISK_ALERT: 'risk_alert',
  SALARY_UPDATE: 'salary_update',
});

const ALERT_TYPES = Object.freeze({
  JOB_MATCH: 'job_match',
  SKILL_DEMAND: 'skill_demand',
  CAREER_OPPORTUNITY: 'career_opportunity',
  SALARY_TREND: 'salary_trend',
  RISK_WARNING: 'risk_warning',
  MARKET_SHIFT: 'market_shift',
});

const PROGRESS_TRIGGERS = Object.freeze({
  CV_PARSED: 'cv_parsed',
  SKILL_GAP_UPDATED: 'skill_gap_updated',
  NEW_JOB_MATCH: 'new_job_match',
  MARKET_TREND_UPDATED: 'market_trend_updated',
  OPPORTUNITY_DETECTED: 'opportunity_detected',
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
});

// ─────────────────────────────────────────────────────────────────────────────
// Source engines
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_ENGINES = Object.freeze({
  LABOR_MARKET: 'labor_market_intelligence',
  OPPORTUNITY_RADAR: 'opportunity_radar',
  JOB_MATCHING: 'job_matching',
  CAREER_RISK_PREDICTOR: 'career_risk_predictor',
  SKILL_GRAPH: 'skill_graph',
  CAREER_DIGITAL_TWIN: 'career_digital_twin',
});

// ─────────────────────────────────────────────────────────────────────────────
// Alert priorities
// ─────────────────────────────────────────────────────────────────────────────

const ALERT_PRIORITY = Object.freeze({
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
  INFORMATIONAL: 5,
});

// ─────────────────────────────────────────────────────────────────────────────
// Queue constants
// ─────────────────────────────────────────────────────────────────────────────

const QUEUE_NAME = 'daily-engagement';

const JOB_NAMES = Object.freeze({
  GENERATE_INSIGHTS: 'generate_insights',
  RECORD_PROGRESS: 'record_progress',
  CREATE_ALERT: 'create_alert',
  DAILY_DIGEST: 'daily_digest',
  CLEANUP_OLD_INSIGHTS: 'cleanup_old_insights',
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache namespace
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'v2';

const CACHE_TTL_SEC = parsePositiveInt(
  process.env.ENGAGEMENT_CACHE_TTL_SEC,
  600
);

const CacheKeys = Object.freeze({
  insights: (userId) => `engagement:${CACHE_VERSION}:insights:${userId}`,
  progress: (userId) => `engagement:${CACHE_VERSION}:progress:${userId}`,
  alerts: (userId) => `engagement:${CACHE_VERSION}:alerts:${userId}`,
  unread: (userId) => `engagement:${CACHE_VERSION}:unread_count:${userId}`,
});

// ─────────────────────────────────────────────────────────────────────────────
// Retention policy
// ─────────────────────────────────────────────────────────────────────────────

const RETENTION = Object.freeze({
  INSIGHTS_DAYS: 30,
  ALERTS_DAYS: 60,
  PROGRESS_ROWS: 365,
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

const DAILY_INSIGHT_LIMIT = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  ENGAGEMENT_EVENTS,
  INSIGHT_TYPES,
  SOURCE_ENGINES,
  ALERT_TYPES,
  ALERT_PRIORITY,
  PROGRESS_TRIGGERS,
  QUEUE_NAME,
  JOB_NAMES,
  CACHE_VERSION,
  CACHE_TTL_SEC,
  CacheKeys,
  RETENTION,
  DAILY_INSIGHT_LIMIT,
});