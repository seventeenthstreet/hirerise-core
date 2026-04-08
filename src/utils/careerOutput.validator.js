'use strict';

/**
 * careerOutput.validator.js
 *
 * Production-safe validation for career AI output payloads.
 *
 * Validates:
 * - required root structure
 * - growthProjection presence
 * - projection array/object validity
 * - optional nested recommendation safety
 * - type integrity for persistence
 */

/**
 * Assert a condition.
 *
 * @param {boolean} condition
 * @param {string} message
 */
function invariant(condition, message) {
  if (!condition) {
    throw new Error(`[CareerOutputValidator] ${message}`);
  }
}

/**
 * Validate projection node.
 *
 * @param {unknown} projection
 */
function validateProjection(projection) {
  invariant(
    projection && typeof projection === 'object',
    'growthProjection.projection must be an object'
  );

  const hasTimeline =
    typeof projection.timeline === 'string' ||
    typeof projection.timeline === 'number';

  const hasStages =
    Array.isArray(projection.stages) ||
    Array.isArray(projection.milestones);

  invariant(
    hasTimeline || hasStages || Object.keys(projection).length > 0,
    'projection must contain timeline, stages, milestones, or meaningful data'
  );
}

/**
 * Validate career output payload.
 *
 * @param {unknown} output
 * @returns {true}
 */
function validateCareerOutput(output) {
  invariant(
    output && typeof output === 'object',
    'LLM output must be a non-null object'
  );

  invariant(
    output.growthProjection &&
      typeof output.growthProjection === 'object',
    'Missing growthProjection'
  );

  validateProjection(output.growthProjection.projection);

  // Optional recommendations block
  if (
    output.recommendations !== undefined &&
    !Array.isArray(output.recommendations)
  ) {
    throw new Error(
      '[CareerOutputValidator] recommendations must be an array'
    );
  }

  // Optional role transitions
  if (
    output.roleTransitions !== undefined &&
    !Array.isArray(output.roleTransitions)
  ) {
    throw new Error(
      '[CareerOutputValidator] roleTransitions must be an array'
    );
  }

  return true;
}

module.exports = {
  validateCareerOutput,
};