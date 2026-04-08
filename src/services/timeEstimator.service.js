'use strict';

/**
 * timeEstimator.service.js
 *
 * Estimates time-to-promotion based on:
 * 1. experience gap
 * 2. skill gap
 *
 * Conservative estimate = max(experience gap, skill gap)
 */

const DEFAULT_MONTHS_PER_SKILL = 3;
const MONTHS_PER_YEAR = 12;

function toSafeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Estimate promotion timeline
 *
 * @param {object} userProfile
 * @param {object} targetRole
 * @param {object} readinessDetails
 * @returns {{
 *   experience_gap_months: number,
 *   skill_gap_months: number,
 *   estimated_months_to_promotion: number
 * }}
 */
function estimateTimeToPromotion(
  userProfile = {},
  targetRole = {},
  readinessDetails = {}
) {
  const requiredYears = Math.max(
    0,
    toSafeNumber(targetRole.min_experience_years)
  );

  const userYears = Math.max(
    0,
    toSafeNumber(userProfile.experience_years)
  );

  const experienceGapMonths =
    requiredYears > userYears
      ? Math.round((requiredYears - userYears) * MONTHS_PER_YEAR)
      : 0;

  const missingSkills = Array.isArray(readinessDetails?.missing_skills)
    ? readinessDetails.missing_skills
    : [];

  const skillGapMonths =
    missingSkills.length * DEFAULT_MONTHS_PER_SKILL;

  const estimatedMonths = Math.max(
    experienceGapMonths,
    skillGapMonths
  );

  return {
    experience_gap_months: experienceGapMonths,
    skill_gap_months: skillGapMonths,
    estimated_months_to_promotion: estimatedMonths,
  };
}

module.exports = {
  estimateTimeToPromotion,
};