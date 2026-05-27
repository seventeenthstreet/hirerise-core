'use strict';

/**
 * src/modules/student-onboarding/services/session.service.js
 *
 * Manages student_onboarding_sessions table operations.
 * All DB access is here — controllers and other services
 * call these functions, never Supabase directly.
 *
 * Public API:
 *   createOrResume(userId)  → { session, created }
 *   getSession(userId)      → SessionShape
 *   updateProgression(...)  → SessionShape
 */

const { supabase }    = require('../../../config/supabase');
const logger          = require('../../../utils/logger');
const { ENGINE_VERSION } = require('../constants');
const { calculateCompletionPct, isOnboardingComplete } = require('../helpers/completion');

const TABLE = 'student_onboarding_sessions';

// ─────────────────────────────────────────────────────────────────────────────
// Service-level error — wraps DB failures without leaking internals
// ─────────────────────────────────────────────────────────────────────────────

class SessionServiceError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} status  HTTP status to return to the client
   */
  constructor(message, code = 'SESSION_ERROR', status = 500) {
    super(message);
    this.name   = 'SessionServiceError';
    this.code   = code;
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: shape a raw DB row into the normalised session response object.
// This is the ONLY place the response shape is assembled.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SessionShape
 * @property {string}   current_step
 * @property {string[]} completed_steps
 * @property {number}   completion_pct
 * @property {boolean}  is_complete
 */

/**
 * @param {object} row  Raw row from student_onboarding_sessions
 * @returns {SessionShape}
 */
function shapeSession(row) {
  const completedSteps = Array.isArray(row.completed_steps) ? row.completed_steps : [];
  return {
    current_step:    row.current_step,
    completed_steps: completedSteps,
    completion_pct:  calculateCompletionPct(completedSteps),
    is_complete:     row.is_complete ?? false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createOrResume
// Fetches existing session or creates a fresh one. Upsert-safe.
// Returns { session: SessionShape, created: boolean }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @returns {Promise<{ session: SessionShape, created: boolean }>}
 */
async function createOrResume(userId) {
  // Try to fetch first — avoids a redundant write on every re-entry
  const { data: existing, error: fetchError } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchError) {
    logger.error(
      { userId, err: fetchError.message },
      '[SessionService] createOrResume: fetch failed',
    );
    throw new SessionServiceError(
      'Failed to retrieve onboarding session.',
      'DB_FETCH_ERROR',
    );
  }

  if (existing) {
    logger.info(
      { userId, step: existing.current_step },
      '[SessionService] session resumed',
    );
    return { session: shapeSession(existing), created: false };
  }

  // No session yet — create a fresh one
  const { data: created, error: insertError } = await supabase
    .from(TABLE)
    .insert({
      user_id:         userId,
      current_step:    'education',
      completed_steps: [],
      is_complete:     false,
      engine_version:  ENGINE_VERSION,
    })
    .select('*')
    .single();

  if (insertError) {
    logger.error(
      { userId, err: insertError.message },
      '[SessionService] createOrResume: insert failed',
    );
    throw new SessionServiceError(
      'Failed to create onboarding session.',
      'DB_INSERT_ERROR',
    );
  }

  logger.info({ userId }, '[SessionService] session created');
  return { session: shapeSession(created), created: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// getSession
// Returns the current session shape for a user, or throws SESSION_NOT_FOUND.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @returns {Promise<SessionShape>}
 */
async function getSession(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error(
      { userId, err: error.message },
      '[SessionService] getSession: fetch failed',
    );
    throw new SessionServiceError(
      'Failed to retrieve onboarding session.',
      'DB_FETCH_ERROR',
    );
  }

  if (!data) {
    throw new SessionServiceError(
      'Onboarding session not found. Call POST /session to begin.',
      'SESSION_NOT_FOUND',
      404,
    );
  }

  return shapeSession(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// updateProgression
// Called by step services after they persist their data.
// Advances current_step and records the completed step atomically.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string}   userId
 * @param {object}   params
 * @param {string}   params.completedStep   The step just finished
 * @param {string}   params.nextStep        The new current_step value
 * @param {string[]} params.completedSteps  Full updated completed_steps array
 * @returns {Promise<SessionShape>}
 */
async function updateProgression(userId, { completedStep, nextStep, completedSteps }) {
  const complete = isOnboardingComplete(completedSteps);

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      current_step:    nextStep,
      completed_steps: completedSteps,
      is_complete:     complete,
    })
    .eq('user_id', userId)
    .select('*')
    .single();

  if (error) {
    logger.error(
      { userId, completedStep, err: error.message },
      '[SessionService] updateProgression: update failed',
    );
    throw new SessionServiceError(
      'Failed to update onboarding progress.',
      'DB_UPDATE_ERROR',
    );
  }

  logger.info(
    { userId, completedStep, nextStep, isComplete: complete },
    '[SessionService] progression updated',
  );

  return shapeSession(data);
}

module.exports = {
  createOrResume,
  getSession,
  updateProgression,
  SessionServiceError,
  // Exported for testing
  shapeSession,
};
