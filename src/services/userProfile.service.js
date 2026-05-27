/**
 * userProfile.service.js
 *
 * PURPOSE:
 *   Handles user profile lookups and creation for the app-entry bootstrap pipeline.
 *
 * CONTEXT:
 *   Both /api/v1/app-entry (cache warm) and /api/v1/users/me (profile fetch)
 *   need to query the Supabase `profiles` table. This service owns that logic
 *   so the route handlers stay thin.
 *
 * SUPABASE CLIENT CHOICE:
 *   We use the service-role client (bypasses RLS) for server-side lookups.
 *   The frontend's RLS policies apply to browser-side queries only.
 *   Server-side handlers run as the service role — this is intentional and safe
 *   because we scope all queries to the verified user's ID (from JWT).
 *
 * TABLE ASSUMPTIONS (adjust column names to match your actual schema):
 *   profiles
 *     id                              UUID  (= auth.uid)
 *     name                            TEXT
 *     email                           TEXT
 *     user_type                       TEXT  ('professional' | 'student' | 'market' | null)
 *     professional_onboarding_complete BOOL
 *     student_onboarding_complete      BOOL
 *     onboarding_completed             BOOL
 *     resume_uploaded                  BOOL
 *     created_at                       TIMESTAMPTZ
 *     updated_at                       TIMESTAMPTZ
 */

'use strict';

const { getSupabaseAdmin } = require('../middleware/supabaseAuth.middleware');

/**
 * Fetch the user profile row for the given auth UID.
 *
 * Returns null (not an error) if no profile row exists yet —
 * this is the expected state for brand-new OAuth sign-ins before
 * the handle_new_user() trigger or manual profile creation runs.
 *
 * @param {string} userId — Supabase auth.uid (from verified JWT)
 * @returns {Promise<object|null>}
 */
async function getProfileByUserId(userId) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle(); // maybeSingle() returns null (not error) when row is absent

  if (error) {
    // Log for debugging; caller decides whether to surface as 404 or 500.
    console.error('[userProfile.service] Profile lookup failed:', {
      userId,
      error: error.message,
      code:  error.code,
    });
    throw error;
  }

  return data; // null if no row
}

/**
 * Create a minimal profile row for a new user.
 *
 * Called by /api/v1/app-entry when the bootstrap finds no profile row.
 * This is the fallback for cases where the Supabase trigger handle_new_user()
 * failed to fire (e.g. trigger disabled, RLS issue, or cold-start race).
 *
 * @param {string} userId
 * @param {string|null} email
 * @param {string|null} name — derived from OAuth metadata if available
 * @returns {Promise<object>} the created profile row
 */
async function createMinimalProfile(userId, email, name) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('profiles')
    .insert({
      id:         userId,
      email:      email ?? null,
      name:       name  ?? null,
      user_type:  null,           // set by direction selection
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    // 23505 = unique_violation — another request already created the row
    // (concurrent bootstrap). Return the existing row instead.
    if (error.code === '23505') {
      console.warn('[userProfile.service] Race condition: profile row already exists for', userId);
      return getProfileByUserId(userId);
    }

    console.error('[userProfile.service] Profile creation failed:', {
      userId,
      error: error.message,
      code:  error.code,
    });
    throw error;
  }

  return data;
}

/**
 * Ensure a profile row exists, creating one if absent.
 * Returns the profile (existing or newly created).
 *
 * @param {string} userId
 * @param {string|null} email
 * @param {string|null} name
 * @returns {Promise<object>}
 */
async function ensureProfile(userId, email, name) {
  const existing = await getProfileByUserId(userId);
  if (existing) return existing;

  console.info('[userProfile.service] No profile found — creating minimal profile for', userId);
  return createMinimalProfile(userId, email, name);
}

module.exports = { getProfileByUserId, createMinimalProfile, ensureProfile };