'use strict';

/**
 * src/modules/student-onboarding/services/careerProfile.service.js
 *
 * WP-XAI2-04 Enterprise Implementation — read-only accessor for the
 * student-onboarding track's stated career signals.
 *
 * Backing table: `student_career_profiles` (confirmed present in
 * `core/supabase/migrations/000_initial_schema.sql`; written by the
 * onboarding-completion RPC and already read directly, ad hoc, by
 * `routes/student-onboarding.routes.js` GET /profile). This service does
 * not introduce a new table or column — it exposes the existing
 * `interests` and `career_curiosities` columns through the same
 * function-object pattern already used by
 * `student-onboarding/services/education.service.js#getEducationProfile`,
 * so `StudentService` (knowledge-runtime) can reuse it read-only instead of
 * querying Supabase directly (Objective 5 — no direct DB access from
 * runtime services).
 *
 * This module owns no writes. Onboarding completion / upsert of
 * `student_career_profiles` remains exactly where it already is
 * (`routes/student-onboarding.routes.js`) — not duplicated here.
 *
 * Public API:
 *   getCareerProfile(userId) → { interests: string[], careerCuriosities: string[] } | null
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const TABLE = 'student_career_profiles';

class CareerProfileServiceError extends Error {
  constructor(message, code = 'CAREER_PROFILE_ERROR', status = 500) {
    super(message);
    this.name = 'CareerProfileServiceError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {string} userId
 * @returns {Promise<{interests: string[], careerCuriosities: string[]}|null>}
 */
async function getCareerProfile(userId) {
  if (!userId) return null;

  const { data, error } = await supabase
    .from(TABLE)
    .select('interests, career_curiosities')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error(
      { userId, err: error.message },
      '[CareerProfileService] getCareerProfile: fetch failed',
    );
    throw new CareerProfileServiceError(
      'Failed to retrieve student career profile.',
      'DB_FETCH_ERROR',
    );
  }

  if (!data) return null;

  return {
    interests: Array.isArray(data.interests) ? data.interests : [],
    careerCuriosities: Array.isArray(data.career_curiosities) ? data.career_curiosities : [],
  };
}

module.exports = {
  getCareerProfile,
  CareerProfileServiceError,
};
