'use strict';

/**
 * src/modules/student-onboarding/services/aspiration.service.js
 *
 * BUSINESS LOGIC — Aspiration Persistence (Phase 2)
 *
 * DOES NOT:
 *   • access the database directly (delegates to aspiration.repository.js)
 *   • handle HTTP (belongs in controller)
 *   • validate payloads (done by validator middleware before reaching here —
 *     saveAspirationStep trusts its `validatedBody` argument)
 *   • touch student_onboarding_sessions / advance onboarding progression
 *
 * WHY THIS SERVICE DOES NOT ADVANCE SESSION STATE:
 *   Every other v2 step in this module handles session progression
 *   differently — academics/education advance server-side on save, while
 *   cognitive's commit step explicitly does not ("Does NOT advance the
 *   session — useUpdateOnboardingStep handles that client-side", see
 *   controllers/cognitive.controller.js).
 *
 *   The aspiration step's frontend flow (front/src/modules/student-onboarding/
 *   page.tsx, handleStepComplete's 'aspiration' case) already calls
 *   useUpdateOnboardingStep({ completedStep: 'aspiration', nextStep:
 *   'processing' }) immediately after onComplete fires — this is pre-existing
 *   behavior, unrelated to this phase, and is the ONLY thing that currently
 *   advances session state for this step. If this service also called
 *   sessionService.updateProgression(), both the backend (here) and the
 *   frontend (via the existing advanceStep call) would independently write
 *   student_onboarding_sessions for the same step completion — exactly the
 *   double-write risk flagged for this phase. So this service intentionally
 *   persists aspiration data ONLY, and leaves session progression entirely
 *   owned by the existing frontend call, unchanged.
 *
 *   This is a data layer, not a progression layer — consistent with the
 *   naming already used elsewhere in this module (repository vs.
 *   session.service).
 */

const repo = require('../repositories/aspiration.repository');

// ─────────────────────────────────────────────────────────────────────────────
// GET ASPIRATION STEP
// Returns the student's saved aspiration record, if any, shaped for the
// step UI's initialData prefill.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @returns {Promise<{ aspiration: { careerInterests: string[], motivationDriver: string|null, timeHorizon: string|null } | null }>}
 */
async function getAspirationStep(ctx, userId) {
  const { supabase } = ctx;

  const row = await repo.fetchAspiration(supabase, userId);

  if (!row) {
    return { aspiration: null };
  }

  return {
    aspiration: {
      careerInterests:  row.career_interests  ?? [],
      motivationDriver: row.motivation_driver ?? null,
      timeHorizon:      row.time_horizon      ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE ASPIRATION STEP
// Upserts the student's aspiration record. Does not touch session state —
// see file-level comment above.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {{ careerInterests: string[], motivationDriver: string|null, timeHorizon: string|null }} validatedBody
 * @returns {Promise<{ aspiration: { careerInterests: string[], motivationDriver: string|null, timeHorizon: string|null } }>}
 */
async function saveAspirationStep(ctx, userId, validatedBody) {
  const { supabase } = ctx;
  const { careerInterests, motivationDriver, timeHorizon } = validatedBody;

  const row = await repo.upsertAspiration(supabase, {
    user_id:            userId,
    career_interests:   careerInterests,
    motivation_driver:  motivationDriver,
    time_horizon:       timeHorizon,
  });

  return {
    aspiration: {
      careerInterests:  row.career_interests  ?? [],
      motivationDriver: row.motivation_driver ?? null,
      timeHorizon:      row.time_horizon      ?? null,
    },
  };
}

module.exports = {
  getAspirationStep,
  saveAspirationStep,
};
