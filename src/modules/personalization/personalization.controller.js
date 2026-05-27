'use strict';

/**
 * src/modules/personalization/personalization.controller.js
 *
 * HTTP handlers for the AI Personalization Engine endpoints.
 *
 * Routes:
 *   GET  /api/v1/career/personalized-recommendations
 *   POST /api/v1/user/behavior-event
 *   GET  /api/v1/user/personalization-profile
 *   POST /api/v1/user/update-behavior-profile
 *
 * CONTRACT NOTE (Phase 2 Hardening — Task 6: Shadowed Local Helper Resolution):
 *   Removed local `sendSuccess` and `sendError` helper functions.
 *   These were V2-shaped but lacked the canonical meta envelope and had a
 *   different argument order, causing import ambiguity and drift risk.
 *   Migrated to shared sendSuccess/sendError from src/shared/response.
 *
 *   NOTE: sendError argument order changed — callers updated to match shared
 *   signature: sendError(res, statusCode, message, code).
 */

const logger = require('../../utils/logger');
const engine = require('./personalization.service');
const { sendSuccess, sendError } = require('../../shared/response');

// ───────────────────────────────────────────────────────────────────────────────
// Request helpers
// ───────────────────────────────────────────────────────────────────────────────

function getAuthenticatedUserId(req) {
  /**
   * Supabase-compatible auth resolution
   * preferred: id → sub
   * legacy fallback: uid
   */
  return req.user?.id || req.user?.sub || req.user?.uid || null;
}

function parseInteger(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) return fallback;

  let safeValue = parsed;

  if (min !== null) safeValue = Math.max(min, safeValue);
  if (max !== null) safeValue = Math.min(max, safeValue);

  return safeValue;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;

  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;

  return fallback;
}

function sanitizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

// ───────────────────────────────────────────────────────────────────────────────
// GET /career/personalized-recommendations
// ───────────────────────────────────────────────────────────────────────────────

async function getPersonalizedRecommendations(req, res) {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return sendError(res, 401, 'Unauthenticated', 'UNAUTHORIZED');
  }

  const topN = parseInteger(req.query.topN, 10, {
    min: 1,
    max: 30,
  });

  const forceRefresh = parseBoolean(req.query.forceRefresh, false);

  try {
    const result = await engine.recommendPersonalizedCareers(userId, {
      topN,
      forceRefresh,
    });

    return sendSuccess(res, result);
  } catch (error) {
    logger.error(
      '[PersonalizationController] getPersonalizedRecommendations failed',
      {
        userId,
        query: req.query,
        error: error.message,
        stack: error.stack,
      }
    );

    return sendError(
      res,
      'Failed to load personalized recommendations',
      500
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// POST /user/behavior-event
// ───────────────────────────────────────────────────────────────────────────────

async function trackBehaviorEvent(req, res) {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return sendError(res, 401, 'Unauthenticated', 'UNAUTHORIZED');
  }

  const {
    event_type,
    entity_type = null,
    entity_id = null,
    entity_label = null,
    metadata = {},
    session_id = null,
  } = req.body || {};

  if (!event_type || typeof event_type !== 'string') {
    return sendError(res, 400, '"event_type" is required', 'INVALID_INPUT');
  }

  try {
    const result = await engine.trackBehaviorEvent(userId, {
      event_type: event_type.trim(),
      entity_type,
      entity_id,
      entity_label,
      metadata: sanitizeObject(metadata),
      session_id,
    });

    return sendSuccess(res, {
      recorded: true,
      event_id: result?.id ?? null,
      queued_profile_update: result?.queued_profile_update ?? false,
    });
  } catch (error) {
    logger.error('[PersonalizationController] trackBehaviorEvent failed', {
      userId,
      event_type,
      error: error.message,
      stack: error.stack,
    });

    return sendError(res, 500, 'Failed to record behavior event', 'INTERNAL_ERROR');
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// GET /user/personalization-profile
// ───────────────────────────────────────────────────────────────────────────────

async function getPersonalizationProfile(req, res) {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return sendError(res, 401, 'Unauthenticated', 'UNAUTHORIZED');
  }

  try {
    const profile = await engine.getPersonalizationProfile(userId);

    if (!profile) {
      return sendSuccess(res, {
        user_id: userId,
        has_profile: false,
        preferred_roles: [],
        preferred_skills: [],
        career_interests: [],
        active_modules: [],
        engagement_score: 0,
        total_events: 0,
        profile_completeness: 0,
        message:
          'No personalization data yet. Interact with the platform to build your profile.',
      });
    }

    return sendSuccess(res, {
      ...profile,
      has_profile: true,
    });
  } catch (error) {
    logger.error(
      '[PersonalizationController] getPersonalizationProfile failed',
      {
        userId,
        error: error.message,
        stack: error.stack,
      }
    );

    return sendError(res, 500, 'Failed to load personalization profile', 'INTERNAL_ERROR');
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// POST /user/update-behavior-profile
// ───────────────────────────────────────────────────────────────────────────────

async function updateBehaviorProfile(req, res) {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return sendError(res, 401, 'Unauthenticated', 'UNAUTHORIZED');
  }

  try {
    const profile = await engine.updateBehaviorProfile(userId);

    return sendSuccess(res, {
      updated: true,
      total_events: profile?.total_events ?? 0,
      roles_detected: profile?.preferred_roles?.length ?? 0,
      skills_detected: profile?.preferred_skills?.length ?? 0,
      engagement_score: profile?.engagement_score ?? 0,
      profile_completeness: profile?.profile_completeness ?? 0,
    });
  } catch (error) {
    logger.error('[PersonalizationController] updateBehaviorProfile failed', {
      userId,
      error: error.message,
      stack: error.stack,
    });

    return sendError(res, 500, 'Failed to update behavior profile', 'INTERNAL_ERROR');
  }
}

module.exports = {
  getPersonalizedRecommendations,
  trackBehaviorEvent,
  getPersonalizationProfile,
  updateBehaviorProfile,
};