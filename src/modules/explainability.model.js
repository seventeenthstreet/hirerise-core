'use strict';

/**
 * explainability.model.js
 *
 * Converts structured analytics into
 * human-readable AI narrative.
 *
 * Pure domain model:
 * - database agnostic
 * - Firebase free
 * - Supabase independent
 * - safe for SSR / service-layer reuse
 */

/**
 * Safely converts value into bounded percentage.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizePercentage(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

/**
 * Safely converts numeric score.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(num));
}

/**
 * Generates human-readable AI explainability narrative.
 *
 * @param {object} params
 * @param {object} params.summary
 * @param {object} params.careerPathInsight
 * @param {object} params.confidenceInsight
 * @returns {string}
 */
function generateNarrative({
  summary = {},
  careerPathInsight = {},
  confidenceInsight = {},
} = {}) {
  const avgPriorityScore = normalizeScore(summary.avgPriorityScore);
  const totalSkillsAnalyzed = normalizeScore(summary.totalSkillsAnalyzed);
  const highPriorityCount = normalizeScore(summary.highPriorityCount);

  const promotion = normalizePercentage(
    careerPathInsight.unlockProbabilityIncrease
  );

  const confidence =
    typeof confidenceInsight.confidenceLevel === 'string' &&
    confidenceInsight.confidenceLevel.trim()
      ? confidenceInsight.confidenceLevel.trim().toUpperCase()
      : 'UNKNOWN';

  const parts = [];

  parts.push(
    `Your current career readiness score averages ${avgPriorityScore}/100 across ${totalSkillsAnalyzed} analyzed skills.`
  );

  if (highPriorityCount > 0) {
    parts.push(
      `There are ${highPriorityCount} high-impact skills that significantly accelerate your career progression.`
    );
  }

  parts.push(
    `Your estimated promotion unlock probability is ${promotion}%, with a ${confidence} confidence level.`
  );

  if (promotion >= 75) {
    parts.push(
      'You are strongly positioned for advancement with targeted skill refinement.'
    );
  } else if (promotion >= 50) {
    parts.push(
      'With focused effort on gateway skills, your promotion likelihood can increase substantially.'
    );
  } else {
    parts.push(
      'Strategic investment in foundational and gateway skills is recommended to accelerate progression.'
    );
  }

  return parts.join(' ');
}

module.exports = {
  generateNarrative,
};