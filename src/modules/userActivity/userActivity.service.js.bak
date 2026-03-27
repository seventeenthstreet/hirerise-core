'use strict';

/**
 * userActivity.service.js
 *
 * Tracks user career actions for:
 *   - Career Improvement Streak (consecutive days with activity)
 *   - Weekly summary (what actions were completed this week)
 *   - CHI trend display (real activity-based progress)
 *
 * EVENT TYPES:
 *   resume_uploaded       — user uploaded or updated their CV
 *   chi_calculated        — Career Health Index was computed
 *   job_analyzed          — Job Fit Analyzer used on a JD
 *   cv_generated          — Custom CV Builder generated a CV
 *   profile_updated       — User updated profile/onboarding
 *   course_started        — User clicked a learning recommendation
 *
 * COLLECTION STRUCTURE:
 *   users/{userId}/activityEvents/{eventId}
 *     eventType   : string
 *     createdAt   : Timestamp
 *     metadata    : object (optional — e.g. { jobTitle, chiScore })
 *
 * STREAK LOGIC:
 *   A streak day = at least one event on that calendar day (UTC).
 *   Consecutive days with events = streak count.
 *   Streak resets if no event on the previous calendar day.
 *
 * @module modules/userActivity/userActivity.service
 */

const { db } = require('../../config/supabase');
const { FieldValue, Timestamp } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ─── Valid event types ────────────────────────────────────────────────────────

const EVENT_TYPES = new Set([
  'resume_uploaded',
  'chi_calculated',
  'job_analyzed',
  'cv_generated',
  'profile_updated',
  'course_started',
]);

// Human-readable labels for the weekly summary
const EVENT_LABELS = {
  resume_uploaded: 'Resume',
  chi_calculated:  'CHI Score',
  job_analyzed:    'Job Fit',
  cv_generated:    'CV Built',
  profile_updated: 'Profile',
  course_started:  'Learning',
};

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * logEvent(userId, eventType, metadata?)
 *
 * Records a user activity event. Call this from existing service handlers
 * after key actions complete successfully.
 *
 * Non-blocking — errors are logged but never thrown.
 *
 * @param {string} userId
 * @param {string} eventType  — one of EVENT_TYPES
 * @param {object} [metadata] — optional context
 */
async function logEvent(userId, eventType, metadata = {}) {
  if (!userId || !EVENT_TYPES.has(eventType)) return;
  try {
    await db
      .collection('users')
      .doc(userId)
      .collection('activityEvents')
      .add({
        eventType,
        metadata,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    // Non-fatal — activity tracking must never break core flows
    logger.warn('[UserActivity] Failed to log event', { userId, eventType, error: err.message });
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * getActivitySummary(userId)
 *
 * Returns streak, weekly actions, and last 7 days activity map.
 * Reads the last 30 days of events — bounded query, no full-collection scan.
 *
 * @param {string} userId
 * @returns {{ streakDays, weeklyActions, dailyMap, lastActiveAt }}
 */
async function getActivitySummary(userId) {
  if (!userId) return _emptyResponse();

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const snap = await db
      .collection('users')
      .doc(userId)
      .collection('activityEvents')
      .where('createdAt', '>=', Timestamp.fromDate(thirtyDaysAgo))
      .orderBy('createdAt', 'desc')
      .limit(200) // max 200 events in 30 days — well within Firestore limits
      .get();

    if (snap.empty) return _emptyResponse();

    const events = snap.docs.map(d => ({
      eventType: d.data().eventType,
      createdAt: d.data().createdAt?.toDate() ?? new Date(),
    }));

    return {
      streakDays:   _computeStreak(events),
      weeklyActions: _computeWeeklyActions(events),
      dailyMap:     _computeDailyMap(events),
      lastActiveAt: events[0]?.createdAt?.toISOString() ?? null,
    };
  } catch (err) {
    logger.warn('[UserActivity] Failed to read activity summary', { userId, error: err.message });
    return _emptyResponse();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _emptyResponse() {
  return { streakDays: 0, weeklyActions: [], dailyMap: {}, lastActiveAt: null };
}

/**
 * _computeStreak(events)
 *
 * Counts consecutive calendar days (UTC) ending today that have at least
 * one event. A gap of 1+ days resets the streak.
 */
function _computeStreak(events) {
  if (!events.length) return 0;

  // Build a Set of ISO date strings (YYYY-MM-DD) that have events
  const activeDays = new Set(
    events.map(e => e.createdAt.toISOString().slice(0, 10))
  );

  let streak = 0;
  const today = new Date();

  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (activeDays.has(key)) {
      streak++;
    } else if (i > 0) {
      // Gap found — streak ends
      break;
    }
    // i === 0 and no event today: continue checking yesterday
    // (allows streak to survive if user hasn't acted yet today)
  }

  return streak;
}

/**
 * _computeWeeklyActions(events)
 *
 * Returns array of unique action labels completed in the last 7 days.
 * e.g. ['Resume', 'CHI Score', 'Job Fit']
 */
function _computeWeeklyActions(events) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const thisWeek = events.filter(e => e.createdAt >= sevenDaysAgo);
  const seen = new Set();
  const actions = [];

  for (const e of thisWeek) {
    const label = EVENT_LABELS[e.eventType];
    if (label && !seen.has(label)) {
      seen.add(label);
      actions.push(label);
    }
  }

  return actions;
}

/**
 * _computeDailyMap(events)
 *
 * Returns a map of the last 7 days → boolean (had activity).
 * Used to render the streak bar on the frontend.
 * e.g. { '2026-03-04': true, '2026-03-05': false, ... }
 */
function _computeDailyMap(events) {
  const activeDays = new Set(
    events.map(e => e.createdAt.toISOString().slice(0, 10))
  );

  const map = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    map[key] = activeDays.has(key);
  }
  return map;
}

module.exports = { logEvent, getActivitySummary, EVENT_TYPES };









