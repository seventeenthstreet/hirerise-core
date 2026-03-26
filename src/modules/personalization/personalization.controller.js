'use strict';

/**
 * personalization.controller.js
 *
 * HTTP handlers for the AI Personalization Engine endpoints.
 *
 * Routes:
 *   GET  /api/v1/career/personalized-recommendations
 *   POST /api/v1/user/behavior-event
 *   GET  /api/v1/user/personalization-profile    (debug / dashboard)
 *   POST /api/v1/user/update-behavior-profile    (admin / manual trigger)
 *
 * @module src/modules/personalization/personalization.controller
 */

'use strict';

const logger  = require('../../utils/logger');
const engine  = require('../../engines/aiPersonalization.engine');

// ─── Response helpers ─────────────────────────────────────────────────────────

const ok  = (res, data)            => res.status(200).json({ success: true,  data });
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

function _userId(req) {
  return req.user?.uid || req.user?.id || null;
}

// ─── GET /career/personalized-recommendations ─────────────────────────────────

/**
 * Returns personalized career recommendations for the authenticated user.
 *
 * Query params:
 *   topN          — max results (default 10, max 30)
 *   forceRefresh  — 'true' to bypass cache and recompute
 *
 * Response includes:
 *   personalized_roles[]   — scored career list
 *   signal_strength        — none | low | medium | high | very_high
 *   has_personalization    — true if enough behavioral data exists
 *   personalization_score  — top role's composite score
 */
async function getPersonalizedRecommendations(req, res) {
  const userId = _userId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  const topN         = Math.min(parseInt(req.query.topN) || 10, 30);
  const forceRefresh = req.query.forceRefresh === 'true';

  try {
    const result = await engine.recommendPersonalizedCareers(userId, {
      topN, forceRefresh,
    });
    ok(res, result);
  } catch (e) {
    logger.error('[PersonalizationController] getPersonalizedRecommendations error', {
      userId, err: e.message,
    });
    bad(res, 'Failed to load personalized recommendations', 500);
  }
}

// ─── POST /user/behavior-event ────────────────────────────────────────────────

/**
 * Track a user behavior event.
 *
 * Body:
 *   event_type    {string}  required — one of EVENT_TYPES
 *   entity_type   {string}  optional — 'role' | 'skill' | 'course' | 'module'
 *   entity_id     {string}  optional — identifier of the entity interacted with
 *   entity_label  {string}  optional — human-readable label for entity
 *   metadata      {object}  optional — additional context
 *   session_id    {string}  optional — client session ID
 *
 * Example body:
 *   { "event_type": "job_click", "entity_type": "role", "entity_id": "data_analyst",
 *     "entity_label": "Data Analyst", "metadata": { "source": "job_matches_page" } }
 */
async function trackBehaviorEvent(req, res) {
  const userId = _userId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  const {
    event_type,
    entity_type,
    entity_id,
    entity_label,
    metadata,
    session_id,
  } = req.body;

  if (!event_type) return bad(res, '"event_type" is required');

  try {
    const result = await engine.trackBehaviorEvent(userId, {
      event_type,
      entity_type,
      entity_id,
      entity_label,
      metadata,
      session_id,
    });

    ok(res, {
      recorded:              true,
      event_id:              result.id,
      queued_profile_update: result.queued_profile_update,
    });
  } catch (e) {
    logger.error('[PersonalizationController] trackBehaviorEvent error', {
      userId, event_type, err: e.message,
    });
    bad(res, 'Failed to record behavior event', 500);
  }
}

// ─── GET /user/personalization-profile ───────────────────────────────────────

/**
 * Returns the user's current personalization profile.
 * Useful for dashboard display and debugging.
 */
async function getPersonalizationProfile(req, res) {
  const userId = _userId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const profile = await engine.getPersonalizationProfile(userId);

    if (!profile) {
      return ok(res, {
        user_id:              userId,
        has_profile:          false,
        preferred_roles:      [],
        preferred_skills:     [],
        career_interests:     [],
        active_modules:       [],
        engagement_score:     0,
        total_events:         0,
        profile_completeness: 0,
        message:              'No personalization data yet. Interact with the platform to build your profile.',
      });
    }

    ok(res, { ...profile, has_profile: true });
  } catch (e) {
    logger.error('[PersonalizationController] getPersonalizationProfile error', {
      userId, err: e.message,
    });
    bad(res, 'Failed to load personalization profile', 500);
  }
}

// ─── POST /user/update-behavior-profile ──────────────────────────────────────

/**
 * Manually trigger a behavior profile update.
 * Useful after a batch of events, or after initial onboarding.
 */
async function updateBehaviorProfile(req, res) {
  const userId = _userId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const profile = await engine.updateBehaviorProfile(userId);
    ok(res, {
      updated:              true,
      total_events:         profile.total_events,
      roles_detected:       (profile.preferred_roles || []).length,
      skills_detected:      (profile.preferred_skills || []).length,
      engagement_score:     profile.engagement_score,
      profile_completeness: profile.profile_completeness,
    });
  } catch (e) {
    logger.error('[PersonalizationController] updateBehaviorProfile error', {
      userId, err: e.message,
    });
    bad(res, 'Failed to update behavior profile', 500);
  }
}

module.exports = {
  getPersonalizedRecommendations,
  trackBehaviorEvent,
  getPersonalizationProfile,
  updateBehaviorProfile,
};









