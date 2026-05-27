'use strict';

/**
 * src/modules/student-onboarding/helpers/completion.js
 *
 * Reusable completion percentage and "is done" logic.
 * Weights are defined here and nowhere else.
 * Future phases only need to add their step weight to STEP_WEIGHTS.
 */

const { COMPLETABLE_STEPS } = require('../constants');

/**
 * Completion weight per step. Must sum to 100.
 *
 * Phase 1 defines 'education' at 20%.
 * Remaining 80% is pre-allocated for future phases.
 * Adjust weights here when a new phase is implemented.
 *
 * @type {Readonly<Record<string, number>>}
 */
const STEP_WEIGHTS = Object.freeze({
  education:  20,
  academics:  25,
  activities: 20,
  cognitive:  20,
  aspiration: 15,
});

/**
 * Computes the completion percentage based on which steps are done.
 * Unknown step names contribute 0 — safe to call with any array.
 *
 * @param {string[]} completedSteps
 * @returns {number} integer 0–100
 */
function calculateCompletionPct(completedSteps) {
  if (!Array.isArray(completedSteps) || completedSteps.length === 0) return 0;

  const total = completedSteps.reduce((sum, step) => {
    return sum + (STEP_WEIGHTS[step] ?? 0);
  }, 0);

  return Math.min(100, Math.round(total));
}

/**
 * Returns true when all completable steps have been finished.
 *
 * @param {string[]} completedSteps
 * @returns {boolean}
 */
function isOnboardingComplete(completedSteps) {
  if (!Array.isArray(completedSteps)) return false;
  return COMPLETABLE_STEPS.every((step) => completedSteps.includes(step));
}

module.exports = {
  calculateCompletionPct,
  isOnboardingComplete,
  STEP_WEIGHTS,
};
