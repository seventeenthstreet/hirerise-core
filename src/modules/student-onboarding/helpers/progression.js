'use strict';

/**
 * src/modules/student-onboarding/helpers/progression.js
 *
 * Centralised step progression logic.
 * Controllers and services must never hard-code step names or ordering.
 * All progression decisions flow through these helpers.
 */

const { ONBOARDING_STEPS, COMPLETABLE_STEPS } = require('../constants');

/**
 * Returns the step that follows the given step in the canonical sequence.
 * Returns null if the given step is the last in the sequence.
 *
 * @param {string} step
 * @returns {string|null}
 */
function getNextStep(step) {
  const idx = ONBOARDING_STEPS.indexOf(step);
  if (idx === -1 || idx === ONBOARDING_STEPS.length - 1) return null;
  return ONBOARDING_STEPS[idx + 1];
}

/**
 * Returns a new completed_steps array that includes the given step.
 * Ensures no duplicates and preserves canonical order.
 *
 * @param {string[]} existingCompleted
 * @param {string}   step
 * @returns {string[]}
 */
function addCompletedStep(existingCompleted, step) {
  const asSet = new Set(Array.isArray(existingCompleted) ? existingCompleted : []);
  asSet.add(step);
  // Always return in canonical order so the array is deterministic
  return COMPLETABLE_STEPS.filter((s) => asSet.has(s));
}

/**
 * Returns true if the given step is already in the completed list.
 *
 * @param {string[]} completedSteps
 * @param {string}   step
 * @returns {boolean}
 */
function isStepCompleted(completedSteps, step) {
  return Array.isArray(completedSteps) && completedSteps.includes(step);
}

/**
 * Determines the correct current_step value after a student completes a step.
 *
 * Rules:
 *  - The student always moves forward, never backward.
 *  - If the student re-submits a step they already passed, current_step
 *    stays where it is — we do not regress.
 *  - If there is no next step, current_step stays at the current value.
 *
 * @param {string} completedStep        The step just finished
 * @param {string} existingCurrentStep  The session's existing current_step
 * @returns {string}
 */
function resolveCurrentStep(completedStep, existingCurrentStep) {
  const next = getNextStep(completedStep);

  // No next step — stay where we are
  if (!next) return existingCurrentStep;

  const existingIdx = ONBOARDING_STEPS.indexOf(existingCurrentStep);
  const nextIdx     = ONBOARDING_STEPS.indexOf(next);

  // Only advance if next is strictly beyond the current position
  return nextIdx > existingIdx ? next : existingCurrentStep;
}

module.exports = {
  getNextStep,
  addCompletedStep,
  isStepCompleted,
  resolveCurrentStep,
};
