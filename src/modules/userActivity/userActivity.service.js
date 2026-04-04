'use strict';

/**
 * userActivity.service.js
 *
 * Supabase-first production implementation for:
 * - Career streak
 * - Weekly activity summary
 * - 7-day activity heatmap
 *
 * Business logic preserved exactly.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

const EVENT_TYPES = Object.freeze(
  new Set([
    'resume_uploaded',
    'chi_calculated',
    'job_analyzed',
    'cv_generated',
    'profile_updated',
    'course_started',
  ])
);

const EVENT_LABELS = Object.freeze({
  resume_uploaded: 'Resume',
  chi_calculated: 'CHI Score',
  job_analyzed: 'Job Fit',
  cv_generated: 'CV Built',
  profile_updated: 'Profile',
  course_started: 'Learning',
});

const MAX_LOOKBACK_DAYS = 30;
const MAX_QUERY_ROWS = 200;
const WEEKLY_WINDOW_DAYS = 7;
const DAILY_MAP_DAYS = 7;

/**
 * Non-blocking activity event logger.
 *
 * Must never throw into business flows.
 *
 * @param {string} userId
 * @param {string} eventType
 * @param {Record<string, any>} [metadata]
 */
async function logEvent(userId, eventType, metadata = {}) {
  if (!userId || !EVENT_TYPES.has(eventType)) return;

  const safeMetadata =
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata)
      ? metadata
      : {};

  try {
    const { error } = await supabase
      .from('activity_events')
      .insert({
        user_id: userId,
        event_type: eventType,
        metadata: safeMetadata,
      });

    if (error) {
      logger.warn('[UserActivity] Event log failed', {
        userId,
        eventType,
        error: error.message,
      });
    }
  } catch (error) {
    logger.warn('[UserActivity] Event log failed', {
      userId,
      eventType,
      error: error.message,
    });
  }
}

/**
 * Reads bounded activity data and computes:
 * - streak
 * - weekly actions
 * - daily map
 * - last active timestamp
 *
 * @param {string} userId
 * @returns {Promise<{
 *   streakDays: number,
 *   weeklyActions: string[],
 *   dailyMap: Record<string, boolean>,
 *   lastActiveAt: string | null
 * }>}
 */
async function getActivitySummary(userId) {
  if (!userId) return emptyResponse();

  try {
    const fromDate = new Date();
    fromDate.setUTCDate(fromDate.getUTCDate() - MAX_LOOKBACK_DAYS);

    const { data, error } = await supabase
      .from('activity_events')
      .select('event_type, created_at')
      .eq('user_id', userId)
      .gte('created_at', fromDate.toISOString())
      .order('created_at', { ascending: false })
      .limit(MAX_QUERY_ROWS);

    if (error) {
      logger.warn('[UserActivity] Summary read failed', {
        userId,
        error: error.message,
      });
      return emptyResponse();
    }

    if (!Array.isArray(data) || data.length === 0) {
      return emptyResponse();
    }

    const events = data
      .filter((row) => row?.created_at)
      .map((row) => ({
        eventType: row.event_type,
        createdAt: new Date(row.created_at),
      }));

    if (!events.length) {
      return emptyResponse();
    }

    return {
      streakDays: computeStreak(events),
      weeklyActions: computeWeeklyActions(events),
      dailyMap: computeDailyMap(events),
      lastActiveAt: events[0]?.createdAt?.toISOString() ?? null,
    };
  } catch (error) {
    logger.warn('[UserActivity] Summary read failed', {
      userId,
      error: error.message,
    });

    return emptyResponse();
  }
}

function emptyResponse() {
  return {
    streakDays: 0,
    weeklyActions: [],
    dailyMap: {},
    lastActiveAt: null,
  };
}

function computeStreak(events) {
  if (!events.length) return 0;

  const activeDays = new Set(
    events.map((e) => e.createdAt.toISOString().slice(0, 10))
  );

  let streak = 0;
  const today = new Date();

  for (let i = 0; i < 365; i++) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - i);

    const key = day.toISOString().slice(0, 10);

    if (activeDays.has(key)) {
      streak += 1;
      continue;
    }

    if (i > 0) break;
  }

  return streak;
}

function computeWeeklyActions(events) {
  const fromDate = new Date();
  fromDate.setUTCDate(fromDate.getUTCDate() - WEEKLY_WINDOW_DAYS);

  const seen = new Set();
  const actions = [];

  for (const event of events) {
    if (event.createdAt < fromDate) continue;

    const label = EVENT_LABELS[event.eventType];
    if (!label || seen.has(label)) continue;

    seen.add(label);
    actions.push(label);
  }

  return actions;
}

function computeDailyMap(events) {
  const activeDays = new Set(
    events.map((e) => e.createdAt.toISOString().slice(0, 10))
  );

  const result = {};

  for (let i = DAILY_MAP_DAYS - 1; i >= 0; i--) {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() - i);

    const key = day.toISOString().slice(0, 10);
    result[key] = activeDays.has(key);
  }

  return result;
}

module.exports = {
  logEvent,
  getActivitySummary,
  EVENT_TYPES,
};