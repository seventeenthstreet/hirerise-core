'use strict';

/**
 * src/modules/student-onboarding/services/education.service.js
 *
 * Manages student_education_profiles table operations and
 * orchestrates session progression after a successful save.
 *
 * Public API:
 *   upsertEducationProfile(userId, payload) → { next_step, session }
 *   getEducationProfile(userId)             → row | null
 */

const { supabase }    = require('../../../config/supabase');
const logger          = require('../../../utils/logger');
const sessionService  = require('./session.service');
const { addCompletedStep, resolveCurrentStep } = require('../helpers/progression');

const TABLE = 'student_education_profiles';

// ─────────────────────────────────────────────────────────────────────────────
// Service-level error
// ─────────────────────────────────────────────────────────────────────────────

class EducationServiceError extends Error {
  constructor(message, code = 'EDUCATION_ERROR', status = 500) {
    super(message);
    this.name   = 'EducationServiceError';
    this.code   = code;
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertEducationProfile
// Saves or replaces the student's education details, then advances the session.
// Returns { next_step: string, session: SessionShape }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @param {object} payload
 * @param {string}      payload.education_level
 * @param {string|null} payload.board_type
 * @param {string|null} payload.school_type
 * @returns {Promise<{ next_step: string, session: import('./session.service').SessionShape }>}
 */
async function upsertEducationProfile(userId, {
  education_level,
  board_type  = null,
  school_type = null,
}) {
  // 1. Upsert education profile — atomic replace on conflict
  const { error: upsertError } = await supabase
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        education_level,
        board_type,
        school_type,
      },
      { onConflict: 'user_id' },
    );

  if (upsertError) {
    logger.error(
      { userId, education_level, err: upsertError.message },
      '[EducationService] upsert failed',
    );
    throw new EducationServiceError(
      'Failed to save education profile.',
      'DB_UPSERT_ERROR',
    );
  }

  logger.info(
    { userId, education_level },
    '[EducationService] education profile saved',
  );

  // 2. Fetch current session to compute progression correctly.
  //    We never trust the client to tell us what step we're on.
  const currentSession = await sessionService.getSession(userId);

  // 3. Compute new progression state
  const newCompleted = addCompletedStep(currentSession.completed_steps, 'education');
  const nextStep     = resolveCurrentStep('education', currentSession.current_step);

  // 4. Persist progression update — session is now authoritative
  const updatedSession = await sessionService.updateProgression(userId, {
    completedStep:  'education',
    nextStep,
    completedSteps: newCompleted,
  });

  return {
    next_step: nextStep,
    session:   updatedSession,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getEducationProfile
// Returns the saved education profile for a user, or null if not yet set.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getEducationProfile(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('education_level, board_type, school_type, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error(
      { userId, err: error.message },
      '[EducationService] getEducationProfile: fetch failed',
    );
    throw new EducationServiceError(
      'Failed to retrieve education profile.',
      'DB_FETCH_ERROR',
    );
  }

  return data ?? null;
}

module.exports = {
  upsertEducationProfile,
  getEducationProfile,
  EducationServiceError,
};
