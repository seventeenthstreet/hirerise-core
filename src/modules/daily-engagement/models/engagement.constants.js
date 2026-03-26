'use strict';

/**
 * modules/daily-engagement/models/engagement.constants.js
 *
 * All shared constants for the Daily Engagement System.
 * Single source of truth — imported by services, workers, and routes.
 */

// ─── BullMQ event types that trigger engagement processing ───────────────────

const ENGAGEMENT_EVENTS = Object.freeze({
  CV_PARSED:              'CV_PARSED',
  SKILL_GAP_UPDATED:      'SKILL_GAP_UPDATED',
  NEW_JOB_MATCH:          'NEW_JOB_MATCH',
  MARKET_TREND_UPDATED:   'MARKET_TREND_UPDATED',
  OPPORTUNITY_DETECTED:   'OPPORTUNITY_DETECTED',
});

// ─── Insight types (maps to daily_career_insights.insight_type) ──────────────

const INSIGHT_TYPES = Object.freeze({
  SKILL_DEMAND:         'skill_demand',
  JOB_MATCH:            'job_match',
  MARKET_TREND:         'market_trend',
  OPPORTUNITY_SIGNAL:   'opportunity_signal',
  RISK_ALERT:           'risk_alert',
  SALARY_UPDATE:        'salary_update',
});

// ─── Source engine identifiers ───────────────────────────────────────────────

const SOURCE_ENGINES = Object.freeze({
  LABOR_MARKET:          'labor_market_intelligence',
  OPPORTUNITY_RADAR:     'opportunity_radar',
  JOB_MATCHING:          'job_matching',
  CAREER_RISK_PREDICTOR: 'career_risk_predictor',
  SKILL_GRAPH:           'skill_graph',
  CAREER_DIGITAL_TWIN:   'career_digital_twin',
});

// ─── Alert types (maps to career_alerts.alert_type) ──────────────────────────

const ALERT_TYPES = Object.freeze({
  JOB_MATCH:            'job_match',
  SKILL_DEMAND:         'skill_demand',
  CAREER_OPPORTUNITY:   'career_opportunity',
  SALARY_TREND:         'salary_trend',
  RISK_WARNING:         'risk_warning',
  MARKET_SHIFT:         'market_shift',
});

// ─── Alert priority levels ────────────────────────────────────────────────────

const ALERT_PRIORITY = Object.freeze({
  CRITICAL:      1,
  HIGH:          2,
  MEDIUM:        3,
  LOW:           4,
  INFORMATIONAL: 5,
});

// ─── Progress trigger events ──────────────────────────────────────────────────

const PROGRESS_TRIGGERS = Object.freeze({
  CV_PARSED:            'cv_parsed',
  SKILL_GAP_UPDATED:    'skill_gap_updated',
  NEW_JOB_MATCH:        'new_job_match',
  MARKET_TREND_UPDATED: 'market_trend_updated',
  OPPORTUNITY_DETECTED: 'opportunity_detected',
  MANUAL:               'manual',
  SCHEDULED:            'scheduled',
});

// ─── BullMQ queue and job names ───────────────────────────────────────────────

const QUEUE_NAME = 'daily-engagement';

const JOB_NAMES = Object.freeze({
  GENERATE_INSIGHTS:    'generate_insights',
  RECORD_PROGRESS:      'record_progress',
  CREATE_ALERT:         'create_alert',
  DAILY_DIGEST:         'daily_digest',
  CLEANUP_OLD_INSIGHTS: 'cleanup_old_insights',
});

// ─── Redis cache key builders ─────────────────────────────────────────────────

const CACHE_TTL_SEC = parseInt(process.env.ENGAGEMENT_CACHE_TTL_SEC || '600', 10); // 10 min

const CacheKeys = Object.freeze({
  insights:  (userId) => `engagement:insights:${userId}`,
  progress:  (userId) => `engagement:progress:${userId}`,
  alerts:    (userId) => `engagement:alerts:${userId}`,
  unread:    (userId) => `engagement:unread_count:${userId}`,
});

// ─── Retention config ─────────────────────────────────────────────────────────

const RETENTION = Object.freeze({
  INSIGHTS_DAYS:  30,  // keep insights for 30 days
  ALERTS_DAYS:    60,  // keep alerts for 60 days
  PROGRESS_ROWS:  365, // keep up to 365 progress snapshots per user
});

// ─── Daily insight limits ─────────────────────────────────────────────────────

const DAILY_INSIGHT_LIMIT = 10; // max new insights generated per user per day

module.exports = {
  ENGAGEMENT_EVENTS,
  INSIGHT_TYPES,
  SOURCE_ENGINES,
  ALERT_TYPES,
  ALERT_PRIORITY,
  PROGRESS_TRIGGERS,
  QUEUE_NAME,
  JOB_NAMES,
  CACHE_TTL_SEC,
  CacheKeys,
  RETENTION,
  DAILY_INSIGHT_LIMIT,
};









