'use strict';

/**
 * careerOutput.validator.js — Stub
 * Replace with real validation logic when ready.
 */

function validateCareerOutput(output) {
  if (!output) throw new Error('LLM output is empty');
  if (!output.growthProjection) throw new Error('Missing growthProjection');
  if (!output.growthProjection.projection) throw new Error('Missing projection data');
  // TODO: add deeper validation
  return true;
}

module.exports = { validateCareerOutput };