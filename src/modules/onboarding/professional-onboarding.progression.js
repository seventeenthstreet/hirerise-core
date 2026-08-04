'use strict';

/**
 * @file src/modules/onboarding/professional-onboarding.progression.js
 *
 * WP-PRO-08 — Professional Onboarding Definition Engine
 *
 * Pure functions that consume professional-onboarding.definition.js and a
 * user's completedSteps/progress/profile data to produce:
 *   - which track the user is on (branching, Task 4)
 *   - the steps[] array the Progress API returns (Task 2)
 *   - the currentStep (Task 2 / naming reconciliation, WP-PRO-03A §4)
 *   - a fuller internal step-state model (current/completed/available/
 *     hidden/optional/skipped/locked — Task 3) for callers that need more
 *     than the frontend's existing { stepId, completed, skipped? } contract
 *
 * DEPENDENCIES: the definition module (pure data) and
 * onboarding.helpers.js#evaluateCompletion (the single existing, approved
 * completion calculator — WP-PRO-06A/06B). This module does not
 * reimplement completion semantics; it only decides which steps are
 * *listed* and in what state, using evaluateCompletion's verdicts as one
 * of its inputs. No Supabase/DB access — same isolation as
 * onboarding.helpers.js's other pure helpers.
 *
 * BOUNDARY (WP-PRO-03A §3): no hardcoded step id, order, or label lives in
 * this file — everything the file references comes from
 * professional-onboarding.definition.js.
 */

const { evaluateCompletion } = require('./onboarding.helpers');
const {
  TRACKS,
  UNIVERSAL_STEPS,
  METHOD_CHOICE_STEP,
  TRACK_STEPS,
  SHARED_DOWNSTREAM_STEPS,
} = require('./professional-onboarding.definition');

// ─────────────────────────────────────────────────────────────────────────
// Track detection (the branching decision — Task 4)
// ─────────────────────────────────────────────────────────────────────────

function historyIncludes(completedSteps, key) {
  return Array.isArray(completedSteps) && completedSteps.includes(key);
}

/**
 * Detect which track a user is on from their step_history alone — no
 * stored "chosen method" field exists or is introduced by this WP (no
 * schema change; Task 5 backward-compatibility). Each track leaves a
 * distinctive marker the moment its first step is submitted:
 *   - Guided Builder → any `guided_*_saved` marker
 *     (onboarding.guidedBuilder.service.js#saveGuidedSection)
 *   - Resume Upload  → `cv_uploaded`
 *     (onboarding.controller.js#uploadCvDuringOnboarding)
 *   - Legacy manual  → `education_experience_saved` / `career_intent_saved`
 *     / `quick_start_saved` (pre-existing endpoints, Task 5)
 *
 * Precedence matters only for the (rare, non-canonical) case where a user
 * has touched more than one path's endpoints directly — Guided Builder and
 * Resume Upload are checked first since they are the two product-approved
 * entry methods this WP implements (Task 4); legacy is the fallback so
 * older in-progress users are never left with an empty steps[] (Task 5).
 *
 * @param {string[]} completedSteps
 * @returns {string|null} one of TRACKS.*, or null if no track chosen yet
 */
function detectTrack(completedSteps = []) {
  if (completedSteps.some((s) => typeof s === 'string' && s.startsWith('guided_'))) {
    return TRACKS.GUIDED_BUILDER;
  }
  if (historyIncludes(completedSteps, 'cv_uploaded')) {
    return TRACKS.RESUME_UPLOAD;
  }
  if (
    historyIncludes(completedSteps, 'education_experience_saved') ||
    historyIncludes(completedSteps, 'career_intent_saved') ||
    historyIncludes(completedSteps, 'quick_start_saved')
  ) {
    return TRACKS.LEGACY_MANUAL;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-step completion (Task 3 — step-state evaluation)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve a single step definition's completion against the user's data.
 * Steps with a `historyKey` are read literally from step_history — the
 * simplest, most direct signal and the one every existing endpoint already
 * produces. Steps with `derivedFrom` have no dedicated endpoint/history
 * entry (evidence-first finding, WP-PRO-03C §1/§3) and must derive
 * completion from another already-computed signal rather than inventing a
 * new persisted flag:
 *
 *   - 'parsingConfidence': Resume Upload's AI parsing happens synchronously
 *     inside the same request as upload_resume (onboarding.controller.js
 *     #uploadCvDuringOnboarding). A dedicated ai_resume_parsing history
 *     entry does not exist; the `confidence.overall` score already written
 *     to onboarding_progress on every upload is the real signal that
 *     parsing produced usable structured data.
 *   - 'trackAUpload': profile_review has no backend endpoint yet
 *     (WP-PRO-03C §3, "net-new relative to the current endpoint
 *     inventory") — its completion is derived from evaluateCompletion's
 *     own trackAUpload verdict (cv_resume_id + personal_details present),
 *     which is the closest existing, approved signal that the
 *     upload-path's data has actually been reviewed/finalized.
 *
 * @param {object} stepDef
 * @param {{completedSteps: string[], progress: object, completion: object}} ctx
 * @returns {boolean}
 */
function isStepComplete(stepDef, ctx) {
  const { completedSteps, progress, completion } = ctx;

  if (stepDef.historyKey) {
    return historyIncludes(completedSteps, stepDef.historyKey);
  }

  if (stepDef.derivedFrom === 'parsingConfidence') {
    return Boolean((progress?.confidence?.overall ?? 0) > 0);
  }

  if (stepDef.derivedFrom === 'trackAUpload') {
    return Boolean(completion?.trackAUpload);
  }

  // No known derivation — evidence-first default is "not complete" rather
  // than inventing a status (WP-PRO-03B/03C discipline carried forward).
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Full internal step-state model (Task 3)
// ─────────────────────────────────────────────────────────────────────────
//
// Supports: current / completed / available / hidden / optional / skipped
// / locked, per WP-PRO-03C §5's canonical state rules. The frontend's
// existing OnboardingStep contract only has { stepId, completed, skipped? }
// (WP-PRO-03C §8's approved, additive-only decision — extending that
// contract is a larger change than this WP makes), so buildSteps() below
// projects this richer model down to that shape for the actual API
// response. This function is exported separately for any caller (future
// admin funnel views, tests) that needs the fuller picture.

const STEP_STATES = Object.freeze({
  CURRENT:   'current',
  COMPLETED: 'completed',
  AVAILABLE: 'available',
  HIDDEN:    'hidden',
  OPTIONAL:  'optional',
  SKIPPED:   'skipped',
  LOCKED:    'locked',
});

/**
 * Build the full, internal step-state list for a user: universal step(s),
 * then either the method-choice routing step (no track chosen yet) or the
 * chosen track's steps plus the shared downstream chain. Steps belonging
 * to a path the user did NOT choose are never included at all — "hidden"
 * means "absent," per WP-PRO-03C §5/§8's canonical rule, not a listed
 * item with a hidden flag.
 *
 * @param {{completedSteps?: string[], progress?: object, profile?: object}} input
 * @returns {{track: string|null, isComplete: boolean, states: Array<object>}}
 */
function computeStepStates({ completedSteps = [], progress = {}, profile = {} } = {}) {
  const completion = evaluateCompletion(progress, profile);
  const track = detectTrack(completedSteps);
  const ctx = { completedSteps, progress, completion };

  const states = [];
  let currentAssigned = false;

  function pushState(stepDef, { locked = false, optional = false } = {}) {
    const completed = isStepComplete(stepDef, ctx);
    let state;

    if (completed) {
      state = STEP_STATES.COMPLETED;
    } else if (locked) {
      state = STEP_STATES.LOCKED;
    } else if (!currentAssigned) {
      state = STEP_STATES.CURRENT;
      currentAssigned = true;
    } else if (optional || stepDef.required === false) {
      state = STEP_STATES.OPTIONAL;
    } else {
      state = STEP_STATES.AVAILABLE;
    }

    states.push({
      stepId:      stepDef.id,
      title:       stepDef.title,
      description: stepDef.description,
      completed,
      state,
    });
  }

  for (const stepDef of UNIVERSAL_STEPS) {
    pushState(stepDef);
  }

  if (!track) {
    const consentDone = states[0]?.completed ?? false;
    if (consentDone) {
      states.push({
        stepId:      METHOD_CHOICE_STEP.id,
        title:       METHOD_CHOICE_STEP.title,
        description: METHOD_CHOICE_STEP.description,
        completed:   false,
        state:       STEP_STATES.CURRENT,
      });
    }
    return { track: null, isComplete: completion.isComplete, states };
  }

  for (const stepDef of TRACK_STEPS[track]) {
    pushState(stepDef, { optional: stepDef.required === false });
  }

  // profile_review-style locked handling: a required step that depends on
  // an earlier step in the same track not yet being done is naturally
  // still CURRENT/AVAILABLE via the sequential pushState pass above, since
  // isStepComplete() already reflects the true dependency (e.g.
  // profile_review can't be complete before ai_resume_parsing is), so no
  // separate lock pass is needed for the tracks defined today.

  for (const stepDef of SHARED_DOWNSTREAM_STEPS) {
    pushState(stepDef, { optional: true });
  }

  return { track, isComplete: completion.isComplete, states };
}

// ─────────────────────────────────────────────────────────────────────────
// Progress API projection (Task 2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the steps[] array in the exact shape the Progress API / frontend
 * OnboardingStep type expects: { stepId, completed, skipped? }. Hidden
 * steps (the other path's steps) are simply not present in the array.
 *
 * @param {{completedSteps?: string[], progress?: object, profile?: object}} input
 * @returns {{track: string|null, isComplete: boolean, steps: Array<{stepId: string, completed: boolean}>}}
 */
function buildSteps(input) {
  const { track, isComplete, states } = computeStepStates(input);

  const steps = states.map((s) => ({
    stepId:    s.stepId,
    completed: s.completed,
  }));

  return { track, isComplete, steps };
}

/**
 * The first not-yet-completed step in the (already path-filtered) steps
 * array — null once every listed step is complete. This is the field
 * WP-PRO-03A's naming-reconciliation section calls for: the frontend
 * (`raw.currentStep ?? raw.steps?.[0]?.stepId ?? null` in
 * hooks/useOnboarding.ts) already reads this field name.
 *
 * @param {Array<{stepId: string, completed: boolean}>} steps
 * @returns {string|null}
 */
function computeCurrentStep(steps) {
  const next = steps.find((s) => !s.completed);
  return next ? next.stepId : null;
}

module.exports = Object.freeze({
  STEP_STATES,
  detectTrack,
  isStepComplete,
  computeStepStates,
  buildSteps,
  computeCurrentStep,
});
