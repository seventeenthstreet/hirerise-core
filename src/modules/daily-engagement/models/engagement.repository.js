'use strict';

/**
 * modules/daily-engagement/models/engagement.repository.js
 *
 * Production-grade Supabase repository for Daily Engagement.
 *
 * Improvements:
 * - stronger null safety
 * - batch chunking
 * - reusable query helpers
 * - better structured logging
 * - reduced payload sizes
 * - safer progress delta handling
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const { RETENTION } = require('./engagement.constants');

const INSERT_BATCH_SIZE = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function buildInsightRow(insight) {
  return {
    user_id: insight.user_id,
    insight_type: insight.insight_type,
    title: insight.title,
    description: insight.description,
    source_engine: insight.source_engine,
    payload: insight.payload ?? {},
    priority: insight.priority ?? 3,
    is_read: false,
  };
}

function buildAlertRow(alert) {
  return {
    user_id: alert.user_id,
    alert_type: alert.alert_type,
    title: alert.title,
    description: alert.description,
    alert_priority: alert.alert_priority ?? 3,
    payload: alert.payload ?? {},
    action_url: alert.action_url ?? null,
    dedup_key: alert.dedup_key ?? null,
    is_read: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Insights
// ─────────────────────────────────────────────────────────────────────────────

async function insertInsight(insight) {
  const { data, error } = await supabase
    .from('daily_career_insights')
    .insert(buildInsightRow(insight))
    .select()
    .single();

  if (error) {
    logger.error('[EngagementRepo] insertInsight failed', {
      error: error.message,
      userId: insight.user_id,
    });
    throw error;
  }

  return data;
}

async function insertInsightsBatch(insights) {
  const safeInsights = safeArray(insights);
  if (safeInsights.length === 0) return [];

  const chunks = chunkArray(
    safeInsights.map(buildInsightRow),
    INSERT_BATCH_SIZE
  );

  const inserted = [];

  for (const chunk of chunks) {
    const { data, error } = await supabase
      .from('daily_career_insights')
      .insert(chunk)
      .select();

    if (error) {
      logger.error('[EngagementRepo] insertInsightsBatch failed', {
        error: error.message,
        chunkSize: chunk.length,
      });
      throw error;
    }

    if (data?.length) inserted.push(...data);
  }

  return inserted;
}

async function getUserInsights(userId, opts = {}) {
  const {
    limit = 20,
    offset = 0,
    unreadOnly = false,
    insightType,
  } = opts;

  let query = supabase
    .from('daily_career_insights')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (unreadOnly) query = query.eq('is_read', false);
  if (insightType) query = query.eq('insight_type', insightType);

  const { data, error } = await query;

  if (error) {
    logger.error('[EngagementRepo] getUserInsights failed', {
      error: error.message,
      userId,
    });
    throw error;
  }

  return data ?? [];
}

async function countTodayInsights(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('daily_career_insights')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', today.toISOString());

  if (error) {
    logger.warn('[EngagementRepo] countTodayInsights failed', {
      error: error.message,
      userId,
    });
    return 0;
  }

  return count ?? 0;
}

async function markInsightsRead(userId, ids = []) {
  let query = supabase
    .from('daily_career_insights')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (ids.length > 0) query = query.in('id', ids);

  const { data, error } = await query.select('id');

  if (error) {
    logger.error('[EngagementRepo] markInsightsRead failed', {
      error: error.message,
      userId,
    });
    throw error;
  }

  return data?.length ?? 0;
}

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
    logger.warn('[EngagementRepo] deleteOldInsights failed', {
      error: error.message,
      userId,
    });
    return 0;
  }

  return data?.length ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

async function getLatestProgressSnapshot(userId) {
  const { data, error } = await supabase
    .from('career_progress_history')
    .select('*')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn('[EngagementRepo] getLatestProgressSnapshot failed', {
      error: error.message,
      userId,
    });
    return null;
  }

  return data;
}

async function insertProgressSnapshot(snapshot) {
  const previous = await getLatestProgressSnapshot(snapshot.user_id);

  const row = {
    user_id: snapshot.user_id,
    career_health_index: snapshot.career_health_index ?? 0,
    skills_count: snapshot.skills_count ?? 0,
    job_match_score: snapshot.job_match_score ?? 0,
    chi_delta: previous
      ? snapshot.career_health_index - previous.career_health_index
      : null,
    skills_delta: previous
      ? snapshot.skills_count - previous.skills_count
      : null,
    job_match_delta: previous
      ? snapshot.job_match_score - previous.job_match_score
      : null,
    trigger_event: snapshot.trigger_event ?? 'manual',
    snapshot: snapshot.snapshot ?? {},
  };

  const { data, error } = await supabase
    .from('career_progress_history')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error('[EngagementRepo] insertProgressSnapshot failed', {
      error: error.message,
      userId: snapshot.user_id,
    });
    throw error;
  }

  return data;
}

async function getProgressHistory(userId, opts = {}) {
  const { limit = 30, days = 90 } = opts;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data, error } = await supabase
    .from('career_progress_history')
    .select(`
      id,
      career_health_index,
      skills_count,
      job_match_score,
      chi_delta,
      skills_delta,
      job_match_delta,
      trigger_event,
      recorded_at
    `)
    .eq('user_id', userId)
    .gte('recorded_at', cutoff.toISOString())
    .order('recorded_at', { ascending: true })
    .limit(limit);

  if (error) {
    logger.error('[EngagementRepo] getProgressHistory failed', {
      error: error.message,
      userId,
    });
    throw error;
  }

  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────────────────────────

async function insertAlert(alert) {
  const row = buildAlertRow(alert);

  if (row.dedup_key) {
    const { data, error } = await supabase
      .from('career_alerts')
      .upsert(row, {
        onConflict: 'user_id,dedup_key',
        ignoreDuplicates: true,
      })
      .select()
      .maybeSingle();

    if (error) {
      logger.error('[EngagementRepo] insertAlert upsert failed', {
        error: error.message,
        userId: alert.user_id,
      });
      throw error;
    }

    return data;
  }

  const { data, error } = await supabase
    .from('career_alerts')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error('[EngagementRepo] insertAlert failed', {
      error: error.message,
      userId: alert.user_id,
    });
    throw error;
  }

  return data;
}

async function getUserAlerts(userId, opts = {}) {
  const {
    limit = 20,
    offset = 0,
    unreadOnly = false,
    alertType,
  } = opts;

  let query = supabase
    .from('career_alerts')
    .select('*')
    .eq('user_id', userId)
    .order('alert_priority', { ascending: true })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (unreadOnly) query = query.eq('is_read', false);
  if (alertType) query = query.eq('alert_type', alertType);

  const { data, error } = await query;

  if (error) {
    logger.error('[EngagementRepo] getUserAlerts failed', {
      error: error.message,
      userId,
    });
    throw error;
  }

  return data ?? [];
}

async function getUnreadAlertCount(userId) {
  const { count, error } = await supabase
    .from('career_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) {
    logger.warn('[EngagementRepo] getUnreadAlertCount failed', {
      error: error.message,
      userId,
    });
    return 0;
  }

  return count ?? 0;
}

async function markAlertsRead(userId, ids = []) {
  const now = new Date().toISOString();

  let query = supabase
    .from('career_alerts')
    .update({
      is_read: true,
      read_at: now,
    })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (ids.length > 0) query = query.in('id', ids);

  const { data, error } = await query.select('id');

  if (error) {
    logger.error('[EngagementRepo] markAlertsRead failed', {
      error: error.message,
      userId,
    });
    throw error;
  }

  return data?.length ?? 0;
}

module.exports = {
  insertInsight,
  insertInsightsBatch,
  getUserInsights,
  countTodayInsights,
  markInsightsRead,
  deleteOldInsights,
  insertProgressSnapshot,
  getLatestProgressSnapshot,
  getProgressHistory,
  insertAlert,
  getUserAlerts,
  getUnreadAlertCount,
  markAlertsRead,
};