"use strict";

/**
 * Explainability Model
 *
 * Converts structured analytics into
 * human-readable AI narrative.
 */

function generateNarrative({
  summary,
  careerPathInsight,
  confidenceInsight,
}) {
  const promotion =
    careerPathInsight?.unlockProbabilityIncrease ?? 0;

  const confidence =
    confidenceInsight?.confidenceLevel ?? "UNKNOWN";

  let narrative = "";

  narrative += `Your current career readiness score averages ${summary.avgPriorityScore}/100 across ${summary.totalSkillsAnalyzed} analyzed skills. `;

  if (summary.highPriorityCount > 0) {
    narrative += `There are ${summary.highPriorityCount} high-impact skills that significantly accelerate your career progression. `;
  }

  narrative += `Your estimated promotion unlock probability is ${promotion}%, with a ${confidence} confidence level. `;

  if (promotion >= 75) {
    narrative += `You are strongly positioned for advancement with targeted skill refinement.`;
  } else if (promotion >= 50) {
    narrative += `With focused effort on gateway skills, your promotion likelihood can increase substantially.`;
  } else {
    narrative += `Strategic investment in foundational and gateway skills is recommended to accelerate progression.`;
  }

  return narrative;
}

module.exports = {
  generateNarrative,
};









