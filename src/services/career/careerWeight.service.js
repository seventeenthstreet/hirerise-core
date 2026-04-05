'use strict';

/**
 * @file careerWeight.service.js
 * @description
 * Computes recency-weighted role context from a career history array.
 *
 * Used by analysis.service.js to enrich AI prompts with weighted
 * career progression data.
 *
 * This service is intentionally database-agnostic and contains
 * zero Firebase / Supabase coupling.
 *
 * Weight formula:
 * - 60% recency bias (later array index = more recent)
 * - 40% tenure contribution
 *
 * Final weights are rounded to 2 decimal places.
 */

/**
 * @typedef {Object} CareerRole
 * @property {string} roleId
 * @property {number} durationMonths
 * @property {boolean} isCurrent
 */

/**
 * @typedef {CareerRole & { weight: number }} WeightedCareerRole
 */

/**
 * Safely converts any duration value into a valid non-negative month number.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeDurationMonths(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Rounds numeric values to 2 decimal places.
 *
 * @param {number} value
 * @returns {number}
 */
function roundToTwo(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Computes recency-weighted role context from ordered career history.
 *
 * IMPORTANT:
 * Input order must remain chronological where later items
 * represent more recent roles.
 *
 * @param {CareerRole[]} [careerHistory=[]]
 * @returns {WeightedCareerRole[]}
 */
function getWeightedRoleContext(careerHistory = []) {
  if (!Array.isArray(careerHistory) || careerHistory.length === 0) {
    return [];
  }

  const normalizedHistory = careerHistory.map((role) => ({
    ...role,
    durationMonths: normalizeDurationMonths(role?.durationMonths),
  }));

  const totalMonths = normalizedHistory.reduce(
    (sum, role) => sum + role.durationMonths,
    0
  );

  if (totalMonths === 0) {
    return normalizedHistory.map((role) => ({
      ...role,
      weight: 0,
    }));
  }

  const totalRoles = normalizedHistory.length;

  return normalizedHistory.map((role, index) => {
    const recencyWeight = (index + 1) / totalRoles;
    const tenureWeight = role.durationMonths / totalMonths;

    const weight = roundToTwo(
      recencyWeight * 0.6 + tenureWeight * 0.4
    );

    return {
      ...role,
      weight,
    };
  });
}

module.exports = {
  getWeightedRoleContext,
};