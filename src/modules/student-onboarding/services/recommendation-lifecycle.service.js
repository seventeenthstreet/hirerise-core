'use strict';

/**
 * @file src/modules/student-onboarding/services/recommendation-lifecycle.service.js
 *
 * PHASE 1 — RECOMMENDATION LIFECYCLE (backend-owned processing transition)
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS:
 *   Audit finding: prior to this pass, the transition of a Student's
 *   session from `aspiration` → `processing` was owned entirely by the
 *   frontend, via a direct Supabase client write from the browser
 *   (see front/src/modules/student-onboarding/api/student-onboarding.api.ts
 *   #updateOnboardingStep, called by page.tsx's aspiration onComplete
 *   handler). No backend code observed or acted on this transition at all
 *   — the POST /v2/step/aspiration route only ever persisted aspiration
 *   data (see aspiration.service.js). This contradicted the frontend's own
 *   documented expectation (processing-step.tsx: "The backend sets
 *   currentStep = 'processing' immediately after 'aspiration' is
 *   submitted...").
 *
 *   This module is the backend-owned fix: it advances the session and
 *   atomically kicks off Recommendation generation, invoked from
 *   aspiration.controller.js immediately after aspiration data is saved.
 *
 * WHY NOT IN aspiration.service.js:
 *   aspiration.service.test.js has an explicit regression guard asserting
 *   that module never imports session.service, to avoid the double-write
 *   risk that was deliberately deferred from a prior phase to "the
 *   trigger-lifecycle pass" — i.e. this one. Rather than weaken that test,
 *   this lifecycle concern is placed in its own module and invoked from
 *   the controller, leaving aspiration.service.js untouched.
 *
 * DOUBLE-WRITE NOTE:
 *   The frontend's existing direct-Supabase write to 'processing' is left
 *   in place (out of scope — frontend changes are not part of this pass).
 *   Once the backend also performs this transition, the frontend's
 *   subsequent write becomes a redundant, idempotent no-op: it computes
 *   the same completed_steps/current_step values and will not regress
 *   session state. This mirrors an already-existing pattern in this
 *   codebase — academic.service.js also advances the session
 *   server-side for the 'academics' step, and the frontend independently
 *   calls its own advanceStep afterward for that same step too (see
 *   front/src/modules/student-onboarding/page.tsx). This is the first
 *   place in the codebase that pattern was deliberately introduced, and
 *   it has not caused observed issues there.
 *
 * ISOLATION CONTRACT:
 *   - The session-progression write (step below, 2) is awaited and its
 *     failure propagates to the caller (matches academic.service.js's
 *     convention: session-advance failures fail the request).
 *   - The Recommendation-generation kickoff (step 3) is best-effort and
 *     isolated: any failure to *start* generation (e.g. a transient DB
 *     error on the duplicate-guard write) is logged and swallowed, never
 *     propagated — a Recommendation generation problem must never
 *     incorrectly fail onboarding completion itself. The generation
 *     work itself always runs fire-and-forget (see
 *     recommendation-engine.js#initiateGeneration).
 */

const sessionService = require('./session.service');
const recommendationEngine = require('./recommendation-engine');
const logger = require('../../../utils/logger');
const { addCompletedStep, resolveCurrentStep } = require('../helpers/progression');

const ASPIRATION_STEP = 'aspiration';

/**
 * Authoritatively advances a Student's onboarding session past `aspiration`
 * (to `processing`, per ONBOARDING_STEPS ordering) and atomically starts
 * Recommendation generation.
 *
 * Call this once, from the backend, immediately after aspiration data has
 * been successfully saved (aspiration.controller.js). Safe to call more
 * than once for the same student (e.g. a resubmitted aspiration form):
 * the session-progression write is idempotent (addCompletedStep dedupes;
 * resolveCurrentStep is deterministic), and generation start is
 * duplicate-guarded by recommendation-engine.js#initiateGeneration.
 *
 * @param {string} userId
 * @returns {Promise<{ session: object }>}
 */
async function initiateProcessingTransition(userId) {
  // 1. Read current session state.
  const currentSession = await sessionService.getSession(userId);

  // 2. Advance session past 'aspiration'. Authoritative and awaited — a
  //    failure here must fail the caller's request, same as every other
  //    step's session-advance convention in this module family.
  const newCompleted = addCompletedStep(currentSession.completed_steps, ASPIRATION_STEP);
  const nextStep = resolveCurrentStep(ASPIRATION_STEP, currentSession.current_step);

  const session = await sessionService.updateProgression(userId, {
    completedStep: ASPIRATION_STEP,
    nextStep,
    completedSteps: newCompleted,
  });

  // 3. Atomically start Recommendation generation. Isolated: a failure to
  //    *start* generation must not fail onboarding completion — it is
  //    logged and swallowed. The generation work itself, once started,
  //    runs fire-and-forget and persists its own success/failure state.
  try {
    await recommendationEngine.initiateGeneration(userId);
  } catch (err) {
    logger.error(
      `[recommendation-lifecycle] Failed to initiate recommendation generation for user ${userId}: ${err.message}`,
    );
  }

  return { session };
}

module.exports = {
  initiateProcessingTransition,
};
