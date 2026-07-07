'use strict';

/**
 * repositories/professionalCareerProfile.repository.js
 *
 * WP-XAI2-04 Enterprise Implementation — read-only accessor for the
 * professional-onboarding track's stated career signals.
 *
 * Two existing, confirmed sources (no new tables/columns):
 *   - `users.career_goal` (text) — single free-text field, edited via
 *     `routes/users.routes.js` PATCH /me (`careerGoal`).
 *   - `user_profiles.data->career_goals` (jsonb array) — written by the
 *     `complete_professional_onboarding` RPC (see
 *     `core/supabase/migrations/000_initial_schema.sql`), which stores
 *     `career_goals` inside the `data` jsonb blob because `user_profiles`
 *     has no dedicated column for it. This repository reads that blob
 *     read-only and does not reinterpret or validate its shape beyond
 *     "array or absent" — the RPC is the sole writer.
 *
 * Deliberately NOT `extends BaseRepository`: `users` has no `soft_deleted`
 * column (confirmed via schema inspection), so `BaseRepository.findById`'s
 * unconditional `WHERE soft_deleted = false` filter would throw a Postgres
 * "column does not exist" error for this table — the same category of
 * schema mismatch already documented in
 * `knowledge-runtime/student/studentIntelligence.repository.js`'s header
 * for `intelligence_entity_snapshots`. Two minimal, direct Supabase reads
 * are used instead, matching that file's precedent of working around a
 * documented mismatch rather than silently forcing a shared base class to
 * fit every table.
 *
 * Public API:
 *   getProfessionalCareerProfile(userId) → { careerGoal: string|null, careerGoals: array } | null
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * @param {string} userId
 * @returns {Promise<{careerGoal: string|null, careerGoals: array}|null>}
 */
async function getProfessionalCareerProfile(userId) {
  if (!userId) return null;

  const [userResult, profileResult] = await Promise.all([
    supabase.from('users').select('career_goal').eq('id', userId).maybeSingle(),
    supabase.from('user_profiles').select('data').eq('user_id', userId).maybeSingle(),
  ]);

  if (userResult.error) {
    logger.error(
      { userId, err: userResult.error.message },
      '[ProfessionalCareerProfileRepository] users.career_goal fetch failed',
    );
  }
  if (profileResult.error) {
    logger.error(
      { userId, err: profileResult.error.message },
      '[ProfessionalCareerProfileRepository] user_profiles.data fetch failed',
    );
  }

  const careerGoal = userResult.data?.career_goal ?? null;
  const rawCareerGoals = profileResult.data?.data?.career_goals;
  const careerGoals = Array.isArray(rawCareerGoals) ? rawCareerGoals : [];

  if (careerGoal === null && careerGoals.length === 0) {
    return null;
  }

  return { careerGoal, careerGoals };
}

module.exports = {
  getProfessionalCareerProfile,
};
