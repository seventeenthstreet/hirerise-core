'use strict';

/**
 * @file src/services/readiness.service.js
 * @description
 * Production-grade readiness scoring service.
 *
 * Optimized for:
 * - Supabase row null safety
 * - deterministic scoring
 * - O(1) skill matching
 * - reusable pure helpers
 * - stable API output
 */

/**
 * Normalize any input into a clean string array.
 *
 * @param {*} value
 * @returns {string[]}
 */
function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

/**
 * Normalize numeric input safely.
 *
 * @param {*} value
 * @returns {number}
 */
function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Round scores consistently to 2 decimals.
 *
 * @param {number} value
 * @returns {number}
 */
function roundScore(value) {
  return Number(value.toFixed(2));
}

/**
 * Compare user skills vs role-required skills.
 *
 * @param {string[]} userSkills
 * @param {string[]} requiredSkills
 * @returns {{
 *   skill_score: number,
 *   matched_skills: string[],
 *   missing_skills: string[]
 * }}
 */
function analyzeSkills(userSkills = [], requiredSkills = []) {
  const normalizedUserSkills = normalizeArray(userSkills);
  const normalizedRequiredSkills = normalizeArray(requiredSkills);

  const userSkillSet = new Set(normalizedUserSkills);
  const matched = [];
  const missing = [];

  for (const skill of normalizedRequiredSkills) {
    if (userSkillSet.has(skill)) {
      matched.push(skill);
    } else {
      missing.push(skill);
    }
  }

  const score = normalizedRequiredSkills.length
    ? matched.length / normalizedRequiredSkills.length
    : 1;

  return {
    skill_score: roundScore(score),
    matched_skills: matched,
    missing_skills: missing
  };
}

/**
 * Compute capped experience score.
 *
 * @param {number} userYears
 * @param {number} requiredYears
 * @returns {number}
 */
function calculateExperienceScore(userYears, requiredYears) {
  const user = normalizeNumber(userYears);
  const required = normalizeNumber(requiredYears);

  if (required <= 0) return 1;
  if (user <= 0) return 0;

  return roundScore(Math.min(user / required, 1));
}

/**
 * Main readiness scoring service.
 *
 * @param {{
 *   skills?: string[],
 *   experience_years?: number
 * }} userProfile
 * @param {{
 *   required_skills?: string[],
 *   min_experience_years?: number
 * }} targetRole
 * @returns {{
 *   readiness_score: number,
 *   skill_score: number,
 *   experience_score: number,
 *   matched_skills: string[],
 *   missing_skills: string[]
 * }}
 */
function calculateReadiness(userProfile = {}, targetRole = {}) {
  const skillAnalysis = analyzeSkills(
    userProfile.skills,
    targetRole.required_skills
  );

  const experienceScore = calculateExperienceScore(
    userProfile.experience_years,
    targetRole.min_experience_years
  );

  const readiness =
    (skillAnalysis.skill_score * 0.6) +
    (experienceScore * 0.4);

  return {
    readiness_score: roundScore(readiness),
    skill_score: skillAnalysis.skill_score,
    experience_score: experienceScore,
    matched_skills: skillAnalysis.matched_skills,
    missing_skills: skillAnalysis.missing_skills
  };
}

module.exports = {
  calculateReadiness,
  analyzeSkills,
  calculateExperienceScore
};