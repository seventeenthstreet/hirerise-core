'use strict';

/**
 * careerWeight.service.js
 *
 * Computes recency-weighted role context from a careerHistory array.
 * Used by analysis.service.js to enrich AI prompts with weighted career data.
 *
 * Mirrors the calculateCareerWeights() logic in onboarding.service.js —
 * single source of truth for weighting algorithm.
 *
 * @param {Array<{ roleId: string, durationMonths: number, isCurrent: boolean }>} careerHistory
 * @returns {Array<{ roleId: string, durationMonths: number, isCurrent: boolean, weight: number }>}
 */
function getWeightedRoleContext(careerHistory = []) {
  if (!Array.isArray(careerHistory) || careerHistory.length === 0) return [];

  const totalMonths = careerHistory.reduce((sum, r) => sum + (r.durationMonths || 0), 0);

  if (totalMonths === 0) {
    return careerHistory.map(r => ({ ...r, weight: 0 }));
  }

  return careerHistory.map((role, idx) => {
    const positionWeight = (idx + 1) / careerHistory.length;         // later = more recent = higher
    const tenureWeight   = (role.durationMonths || 0) / totalMonths;
    const weight         = Math.round(((positionWeight * 0.6) + (tenureWeight * 0.4)) * 100) / 100;
    return { ...role, weight };
  });
}

module.exports = { getWeightedRoleContext };








