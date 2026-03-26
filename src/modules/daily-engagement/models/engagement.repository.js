'use strict';

/**
 * modules/daily-engagement/models/engagement.repository.js
 *
 * All Supabase PostgreSQL operations for the Daily Engagement System.
 *
 * Three logical repositories in one file (kept together for cohesion since
 * the tables are tightly related). Each section is clearly delineated.
 *
 * Follows the same pattern as the rest of the platform:
 *   - Uses the supabaseClient singleton
 *   - Throws on unexpected errors; returns null/[] on expected empty results
 *   - Service layer handles Redis caching; this layer is pure DB
 */

'use strict';

const supabase = require('../../../core/supabaseClient');
const logger   = require('../../../utils/logger');

const {
  RETENTION,
  DAILY_INSIGHT_LIMIT,
} = require('./engagement.constants');

// ══════════════════════════════════════════════════════════════════════════════
//  INSIGHTS REPOSITORY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * insertInsight(insight)
 * Write a single insight row.
 *
 * @param {Object} insight  — { user_id, insight_type, title, description, source_engine, payload?, priority? }
 * @returns {Promise<Object>}  The inserted row
 */
async function insertInsight(insight) {
  const { data, error } = await supabase
    .from('daily_career_insights')
    .insert({
      user_id:      insight.user_id,
      insight_type: insight.insight_type,
      title:        insight.title,
      description:  insight.description,
      source_engine:insight.source_engine,
      payload:      insight.payload      || {},
      priority:     insight.priority     || 3,
      is_read:      false,
    })
    .select()
    .single();

  if (error) {
    logger.error('[EngagementRepo] insertInsight failed', { error: error.message });
    throw new Error(error.message);
  }
  return data;
}

/**
 * insertInsightsBatch(insights[])
 * Bulk-insert multiple insights in one round-trip.
 *
 * @param {Object[]} insights
 * @returns {Promise<Object[]>}
 */
async function insertInsightsBatch(insights) {
  if (!insights || insights.length === 0) return [];

  const rows = insights.map(i => ({
    user_id:       i.user_id,
    insight_type:  i.insight_type,
    title:         i.title,
    description:   i.description,
    source_engine: i.source_engine,
    payload:       i.payload  || {},
    priority:      i.priority || 3,
    is_read:       false,
  }));

  const { data, error } = await supabase
    .from('daily_career_insights')
    .insert(rows)
    .select();

  if (error) {
    logger.error('[EngagementRepo] insertInsightsBatch failed', { error: error.message });
    throw new Error(error.message);
  }
  return data || [];
}

/**
 * getUserInsights(userId, { limit, offset, unreadOnly, insightType })
 * Fetch the user's insight feed, newest first.
 *
 * @param {string} userId
 * @param {Object} [opts]
 * @returns {Promise<Object[]>}
 */
async function getUserInsights(userId, opts = {}) {
  const {
    limit      = 20,
    offset     = 0,
    unreadOnly = false,
    insightType,
  } = opts;

  let query = supabase
    .from('daily_career_insights')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (unreadOnly)   query = query.eq('is_read', false);
  if (insightType)  query = query.eq('insight_type', insightType);

  const { data, error } = await query;

  if (error) {
    logger.error('[EngagementRepo] getUserInsights failed', { error: error.message });
    throw new Error(error.message);
  }
  return data || [];
}

/**
 * countTodayInsights(userId)
 * Returns how many insights were generated for a user today.
 * Used to enforce DAILY_INSIGHT_LIMIT.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function countTodayInsights(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('daily_career_insights')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', today.toISOString());

  if (error) {
    logger.warn('[EngagementRepo] countTodayInsights failed (non-fatal)', { error: error.message });
    return 0;
  }
  return count || 0;
}

/**
 * markInsightsRead(userId, ids[])
 * Mark specific insights as read. Pass empty ids[] to mark all.
 *
 * @param {string}   userId
 * @param {string[]} ids
 * @returns {Promise<number>}  Count of rows updated
 */
async function markInsightsRead(userId, ids = []) {
  let query = supabase
    .from('daily_career_insights')
    .update({ is_read: true })
    .eq('user_id', userId);

  if (ids.length > 0) query = query.in('id', ids);

  const { data, error } = await query.select('id');

  if (error) {
    logger.error('[EngagementRepo] markInsightsRead failed', { error: error.message });
    throw new Error(error.message);
  }
  return (data || []).length;
}

/**
 * deleteOldInsights(userId)
 * Prune insights older than RETENTION.INSIGHTS_DAYS.
 *
 * @param {string} userId
 * @returns {Promise<number>}  Count deleted
 */
async function deleteOldInsights(userId) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION.INSIGHTS_DAYS);

  const { data, error } = await supabase
    .from('daily_career_insights')
    .delete()
    .eq('user_id', userId)
    .lt('created_at', cutoff.toISOString())
    .select('id');

  if (error) {
    logger.warn('[EngagementRepo] deleteOldInsights failed', { error: error.message });
    return 0;
  }
  return (data || []).length;
}

// ══════════════════════════════════════════════════════════════════════════════
//  PROGRESS REPOSITORY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * insertProgressSnapshot(snapshot)
 * Record a new progress data point.
 *
 * @param {Object} snapshot  — { user_id, career_health_index, skills_count, job_match_score, trigger_event, snapshot? }
 * @returns {Promise<Object>}
 */
async function insertProgressSnapshot(snapshot) {
  // Calculate deltas vs the most recent snapshot
  const previous = await getLatestProgressSnapshot(snapshot.user_id);

  const chi_delta        = previous ? snapshot.career_health_index - previous.career_health_index : null;
  const skills_delta     = previous ? snapshot.skills_count        - previous.skills_count        : null;
  const job_match_delta  = previous ? snapshot.job_match_score     - previous.job_match_score     : null;

  const { data, error } = await supabase
    .from('career_progress_history')
    .insert({
      user_id:             snapshot.user_id,
      career_health_index: snapshot.career_health_index || 0,
      skills_count:        snapshot.skills_count        || 0,
      job_match_score:     snapshot.job_match_score     || 0,
      chi_delta,
      skills_delta,
      job_match_delta,
      trigger_event:       snapshot.trigger_event       || 'manual',
      snapshot:            snapshot.snapshot            || {},
    })
    .select()
    .single();

  if (error) {
    logger.error('[EngagementRepo] insertProgressSnapshot failed', { error: error.message });
    throw new Error(error.message);
  }
  return data;
}

/**
 * getLatestProgressSnapshot(userId)
 * Returns the single most recent progress record for a user.
 *
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getLatestProgressSnapshot(userId) {
  const { data, error } = await supabase
    .from('career_progress_history')
    .select('*')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn('[EngagementRepo] getLatestProgressSnapshot failed', { error: error.message });
    return null;
  }
  return data;
}

/**
 * getProgressHistory(userId, { limit, days })
 * Fetch chronological progress snapshots for charting.
 *
 * @param {string} userId
 * @param {Object} [opts]  { limit: 30, days: 90 }
 * @returns {Promise<Object[]>}  Oldest first (for charts)
 */
async function getProgressHistory(userId, opts = {}) {
  const { limit = 30, days = 90 } = opts;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data, error } = await supabase
    .from('career_progress_history')
    .select('id, career_health_index, skills_count, job_match_score, chi_delta, skills_delta, job_match_delta, trigger_event, recorded_at')
    .eq('user_id', userId)
    .gte('recorded_at', cutoff.toISOString())
    .order('recorded_at', { ascending: true })
    .limit(limit);

  if (error) {
    logger.error('[EngagementRepo] getProgressHistory failed', { error: error.message });
    throw new Error(error.message);
  }
  return data || [];
}

// ══════════════════════════════════════════════════════════════════════════════
//  ALERTS REPOSITORY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * insertAlert(alert)
 * Create a new alert. Silently skips if dedup_key already exists.
 *
 * @param {Object} alert  — { user_id, alert_type, title, description, alert_priority, payload?, action_url?, dedup_key? }
 * @returns {Promise<Object|null>}  null if deduplicated
 */
async function insertAlert(alert) {
  const row = {
    user_id:        alert.user_id,
    alert_type:     alert.alert_type,
    title:          alert.title,
    description:    alert.description,
    alert_priority: alert.alert_priority || 3,
    payload:        alert.payload        || {},
    action_url:     alert.action_url     || null,
    dedup_key:      alert.dedup_key      || null,
    is_read:        false,
  };

  // Use upsert with dedup_key to prevent duplicates
  if (alert.dedup_key) {
    const { data, error } = await supabase
      .from('career_alerts')
      .upsert(row, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
      .select()
      .maybeSingle();

    if (error) {
      logger.error('[EngagementRepo] insertAlert (upsert) failed', { error: error.message });
      throw new Error(error.message);
    }
    return data; // null if duplicate was ignored
  }

  const { data, error } = await supabase
    .from('career_alerts')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error('[EngagementRepo] insertAlert failed', { error: error.message });
    throw new Error(error.message);
  }
  return data;
}

/**
 * getUserAlerts(userId, { limit, offset, unreadOnly, alertType })
 *
 * @param {string} userId
 * @param {Object} [opts]
 * @returns {Promise<Object[]>}
 */
async function getUserAlerts(userId, opts = {}) {
  const {
    limit      = 20,
    offset     = 0,
    unreadOnly = false,
    alertType,
  } = opts;

  let query = supabase
    .from('career_alerts')
    .select('*')
    .eq('user_id', userId)
    .order('alert_priority', { ascending: true })
    .order('created_at',     { ascending: false })
    .range(offset, offset + limit - 1);

  if (unreadOnly) query = query.eq('is_read', false);
  if (alertType)  query = query.eq('alert_type', alertType);

  const { data, error } = await query;

  if (error) {
    logger.error('[EngagementRepo] getUserAlerts failed', { error: error.message });
    throw new Error(error.message);
  }
  return data || [];
}

/**
 * getUnreadAlertCount(userId)
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getUnreadAlertCount(userId) {
  const { count, error } = await supabase
    .from('career_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) {
    logger.warn('[EngagementRepo] getUnreadAlertCount failed', { error: error.message });
    return 0;
  }
  return count || 0;
}

/**
 * markAlertsRead(userId, ids[])
 * Mark specific alerts as read. Pass empty ids[] to mark all.
 *
 * @param {string}   userId
 * @param {string[]} ids
 * @returns {Promise<number>}  rows updated
 */
async function markAlertsRead(userId, ids = []) {
  const now = new Date().toISOString();

  let query = supabase
    .from('career_alerts')
    .update({ is_read: true, read_at: now })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (ids.length > 0) query = query.in('id', ids);

  const { data, error } = await query.select('id');

  if (error) {
    logger.error('[EngagementRepo] markAlertsRead failed', { error: error.message });
    throw new Error(error.message);
  }
  return (data || []).length;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Insights
  insertInsight,
  insertInsightsBatch,
  getUserInsights,
  countTodayInsights,
  markInsightsRead,
  deleteOldInsights,

  // Progress
  insertProgressSnapshot,
  getLatestProgressSnapshot,
  getProgressHistory,

  // Alerts
  insertAlert,
  getUserAlerts,
  getUnreadAlertCount,
  markAlertsRead,
};









