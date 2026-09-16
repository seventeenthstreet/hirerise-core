'use strict';

/**
 * src/modules/student-onboarding/repositories/aspiration.repository.js
 *
 * DATABASE ACCESS LAYER — Aspiration Persistence (Phase 2)
 *
 * PATTERN (matching cognitive.repository.js / academic.repository.js):
 *   Every function accepts a supabase service-role client and a userId.
 *   Zero business logic. Zero validation. Only Supabase queries.
 *
 * UPSERT STRATEGY:
 *   • student_aspirations → upsert on (user_id) — one row per student.
 *
 * SCOPE NOTE: this repository does not read or write
 * student_onboarding_sessions. Session progression for the aspiration step
 * is owned entirely by the frontend's existing useUpdateOnboardingStep call
 * (see front/src/modules/student-onboarding/page.tsx, case 'aspiration').
 * This repository — and the service/controller above it — persist aspiration
 * data only, so as not to introduce a second, competing writer of session
 * state (see server-registration note in aspiration.routes.js for the full
 * reasoning).
 */

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts (creates or overwrites) the student's aspiration record.
 * One row per student — a later save replaces the prior values entirely,
 * it does not merge with them (matching the frontend's own form state,
 * which always resubmits the full set of three fields together).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   user_id: string,
 *   career_interests: string[],
 *   motivation_driver: string|null,
 *   time_horizon: string|null,
 * }} payload
 * @returns {Promise<Object>} the persisted row
 */
async function upsertAspiration(supabase, payload) {
  const { data, error } = await supabase
    .from('student_aspirations')
    .upsert(
      {
        user_id:            payload.user_id,
        career_interests:   payload.career_interests,
        motivation_driver:  payload.motivation_driver,
        time_horizon:       payload.time_horizon,
      },
      {
        onConflict:       'user_id',
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the student's saved aspiration record, if any.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function fetchAspiration(supabase, userId) {
  const { data, error } = await supabase
    .from('student_aspirations')
    .select('user_id, career_interests, motivation_driver, time_horizon, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

module.exports = {
  upsertAspiration,
  fetchAspiration,
};
