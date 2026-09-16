'use strict';

/**
 * src/modules/student-onboarding/services/canonical-context.service.js
 *
 * PHASE 0 — CANONICAL STUDENT CONTEXT FOUNDATION
 * ═══════════════════════════════════════════════
 * Reusable foundation for a later Recommendation Context implementation.
 *
 * This module ONLY retrieves and normalizes canonical Student MVP data. It
 * does NOT score, weight, rank, choose Career Areas, or generate
 * Recommendations/Mentor output. It is not a second Intelligence engine.
 *
 * Canonical sources read (Phase 0 brief §19):
 *   Education     — student_education_profiles      (education.service.js)
 *   Academics     — student_academic_records,
 *                   student_academic_subjects        (academic.repository.js)
 *   Activities    — student_activities,
 *                   activity_taxonomy (embedded via achievements/reflection)
 *                                                     (activity.repository.js)
 *   Achievements  — student_activity_achievements     (activity.repository.js)
 *   Cognitive     — student_cognitive_signals (optional/best-effort)
 *                                                     (cognitive.repository.js)
 *   Aspiration    — student_aspirations               (aspiration.repository.js)
 *
 * Explicitly NOT read (Phase 0 brief §19 — legacy Recommendation context):
 *   student_academics_profiles, student_interests_profiles,
 *   student_learning_styles, student_exposure_profiles,
 *   student_financial_profiles.
 *
 * PHASE 1 ADDITION — Cross-domain Intelligence + readiness summary:
 *   Consumes Student Intelligence exclusively through the existing
 *   intelligence.service.js#getStudentVector / #getStudentConfidence
 *   query methods (never recomputed, never called over HTTP — see that
 *   module's own "QUERY METHODS" section). Like cognitive data, this is
 *   optional/best-effort: an Intelligence read failure or absence must
 *   not fail context assembly, and no Intelligence value is fabricated
 *   when unavailable (Phase 1 spec §6).
 *
 *   `readiness` is a pure, derived summary of which canonical domains
 *   have any data present, computed only from the already-assembled
 *   context fields above (no additional reads) — it never overwrites or
 *   duplicates student_onboarding_sessions' own step-completion tracking.
 *
 * Public API:
 *   getContextVersion()                 → string
 *   assembleCanonicalStudentContext(userId, [supabase]) → CanonicalStudentContext
 */

const { supabase: defaultSupabase } = require('../../../config/supabase');
const { fetchAcademicData }         = require('../repositories/academic.repository');
const { fetchStudentActivityData }  = require('../repositories/activity.repository');
const { fetchStudentCognitiveData } = require('../repositories/cognitive.repository');
const { fetchAspiration }           = require('../repositories/aspiration.repository');
const intelligenceService           = require('./intelligence.service');

const EDUCATION_TABLE = 'student_education_profiles';

// ─────────────────────────────────────────────────────────────────────────────
// Education read
// ─────────────────────────────────────────────────────────────────────────────
//
// education.service.js#getEducationProfile is NOT reused here on purpose:
// this file is itself a *.service.js module, and per the project's
// dependency-rule lint (local/no-service-importing-service, Doc 08),
// services must not call each other directly. There is no
// education.repository.js to depend on instead (unlike academics/
// activities/cognitive/aspiration, each of which already has a
// repository-layer read this module composes). Rather than introduce a
// new repository file or a coordinator layer for a single read — outside
// this pass's change budget — this performs the same read
// education.service.js#getEducationProfile does (identical table and
// column selection), independently, at the repository-equivalent level.
// If a shared education repository is extracted in a later pass, this
// should be updated to depend on it instead of duplicating the query.
async function fetchEducationProfile(supabaseClient, userId) {
  const { data, error } = await supabaseClient
    .from(EDUCATION_TABLE)
    .select('education_level, board_type, school_type, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context version
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structure/contract version of the canonical Student context shape
 * returned by this module. Deterministic — not derived from a timestamp,
 * and never incremented per student. Bump only when the shape/contract of
 * `assembleCanonicalStudentContext`'s return value changes.
 *
 * Bumped v1 → v2 in Phase 1 (Recommendation Engine, controlled
 * implementation pass 1): the returned shape gained `intelligence` and
 * `readiness`, a genuine contract change per this function's own bump
 * policy above. No historical `student_recommendation_results` row is
 * affected — Phase 0 left `context_version` NULL for every existing row
 * (nothing to migrate/reconcile).
 *
 * @returns {string}
 */
function getContextVersion() {
  return 'student-recommendation-context-v2';
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness / completion summary (pure — derived only from assembled fields)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives a per-domain "has any data" readiness summary from the
 * already-assembled canonical fields. Pure and independently testable —
 * takes no supabase client and performs no reads of its own. This is a
 * presence summary for Recommendation Engine consumption, not a
 * replacement for student_onboarding_sessions' own step-completion
 * bookkeeping, which this module never reads or writes.
 *
 * @param {Object} params
 * @param {Object|null} params.education
 * @param {{records: Object[], subjects: Object[]}} params.academics
 * @param {{activities: Object[], achievements: Object[], reflection: Object|null}} params.activities
 * @param {Object|null} params.cognitive
 * @param {Object|null} params.aspiration
 * @param {Object|null} params.intelligenceVector
 * @returns {{
 *   education: boolean,
 *   academics: boolean,
 *   activities: boolean,
 *   cognitive: boolean,
 *   aspiration: boolean,
 *   intelligenceAvailable: boolean,
 * }}
 */
function deriveReadinessSummary({
  education,
  academics,
  activities,
  cognitive,
  aspiration,
  intelligenceVector,
}) {
  return {
    education: Boolean(education),
    academics: Boolean(academics?.records?.length),
    activities: Boolean(activities?.activities?.length),
    cognitive: Boolean(cognitive?.signals || cognitive?.responses?.length),
    aspiration: Boolean(aspiration),
    intelligenceAvailable: Boolean(intelligenceVector),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assembles the canonical Student data foundation for a single, correctly
 * scoped user. Pure composition of existing canonical reads — no scoring,
 * no weighting, no Career Area mapping, no Recommendation/Mentor generation.
 *
 * Cognitive data is optional/best-effort per Phase 0 brief §19: a failure
 * fetching it does not fail context assembly as a whole.
 *
 * @param {string} userId - Must be the verified/authenticated user's id.
 * @param {import('@supabase/supabase-js').SupabaseClient} [supabaseClient]
 *   Optional Supabase client override (defaults to the shared app client).
 *   Injectable so tests can supply a mock without touching module-level
 *   config.
 * @returns {Promise<{
 *   userId: string,
 *   education: Object|null,
 *   academics: { records: Object[], subjects: Object[] },
 *   activities: { activities: Object[], achievements: Object[], reflection: Object|null },
 *   achievements: Object[],
 *   cognitive: { responses: Object[], signals: Object|null } | null,
 *   aspiration: Object|null,
 *   intelligence: { vector: Object|null, confidence: Object[] },
 *   readiness: ReturnType<typeof deriveReadinessSummary>,
 *   contextVersion: string,
 * }>}
 */
async function assembleCanonicalStudentContext(userId, supabaseClient = defaultSupabase) {
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('assembleCanonicalStudentContext requires a string userId');
  }

  const [education, academics, activityData, aspiration] = await Promise.all([
    fetchEducationProfile(supabaseClient, userId),
    fetchAcademicData(supabaseClient, userId),
    fetchStudentActivityData(supabaseClient, userId),
    fetchAspiration(supabaseClient, userId),
  ]);

  // Cognitive data is optional/best-effort (Phase 0 brief §19) — a read
  // failure here must not fail the whole canonical context.
  let cognitive = null;
  try {
    cognitive = await fetchStudentCognitiveData(supabaseClient, userId);
  } catch {
    cognitive = null;
  }

  // Cross-domain Intelligence is optional/best-effort (Phase 1 spec §6):
  // read via the existing query methods only, never recomputed. A read
  // failure or "no vector yet" must not fail context assembly, and no
  // value is fabricated when unavailable — vector/confidence stay at
  // their explicit "unavailable" defaults (null / empty array).
  let intelligenceVector = null;
  let intelligenceConfidence = [];
  try {
    intelligenceVector = await intelligenceService.getStudentVector(userId);
  } catch {
    intelligenceVector = null;
  }
  try {
    intelligenceConfidence = await intelligenceService.getStudentConfidence(userId);
  } catch {
    intelligenceConfidence = [];
  }

  const readiness = deriveReadinessSummary({
    education,
    academics,
    activities: activityData,
    cognitive,
    aspiration,
    intelligenceVector,
  });

  return {
    userId,
    education,
    academics,
    activities: activityData,
    achievements: activityData.achievements,
    cognitive,
    aspiration,
    intelligence: {
      vector: intelligenceVector ?? null,
      confidence: intelligenceConfidence ?? [],
    },
    readiness,
    contextVersion: getContextVersion(),
  };
}

module.exports = {
  getContextVersion,
  deriveReadinessSummary,
  assembleCanonicalStudentContext,
};
