'use strict';

/**
 * src/modules/resumeGrowth/resumeGrowth.engine.js
 *
 * Pure deterministic scoring engine.
 * No DB, no I/O, no framework coupling.
 *
 * Production upgrades:
 * - stronger null safety
 * - faster Set reuse
 * - invalid input guards
 * - date parsing hardening
 * - divide-by-zero protection
 * - immutable constants
 * - safer numeric coercion
 * - deterministic scoring
 */

// ──────────────────────────────────────────────────────────────
// Immutable scoring configuration
// ──────────────────────────────────────────────────────────────

const LEVEL_THRESHOLDS = Object.freeze([
  Object.freeze({ level: 'L1', minYears: 0, minSkillCoverage: 0 }),
  Object.freeze({ level: 'L2', minYears: 2, minSkillCoverage: 40 }),
  Object.freeze({ level: 'L3', minYears: 5, minSkillCoverage: 65 }),
  Object.freeze({ level: 'L4', minYears: 8, minSkillCoverage: 80 }),
  Object.freeze({ level: 'L5', minYears: 12, minSkillCoverage: 90 }),
]);

const PROMOTION_READINESS_BANDS = Object.freeze([
  Object.freeze({ min: 80, label: 'High' }),
  Object.freeze({ min: 55, label: 'Moderate' }),
  Object.freeze({ min: 0, label: 'Early' }),
]);

const DEGREE_WEIGHTS = Object.freeze({
  phd: 100,
  doctorate: 100,
  masters: 85,
  mba: 85,
  bachelor: 65,
  associate: 45,
  diploma: 35,
  certificate: 30,
});

// ──────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────

function toSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toSafeLowerSet(values) {
  return new Set(
    toSafeArray(values)
      .filter(v => typeof v === 'string')
      .map(v => v.trim().toLowerCase())
      .filter(Boolean)
  );
}

function toSafeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

// ──────────────────────────────────────────────────────────────
// Skill Coverage
// ──────────────────────────────────────────────────────────────

function calculateSkillCoverage(candidateSkills, requiredSkills, preferredSkills = []) {
  const required = toSafeArray(requiredSkills);
  const preferred = toSafeArray(preferredSkills);
  const candidateSet = toSafeLowerSet(candidateSkills);

  if (!required.length) return 50;

  const requiredHits = required.filter(skill =>
    candidateSet.has(String(skill).toLowerCase())
  ).length;

  const preferredHits = preferred.filter(skill =>
    candidateSet.has(String(skill).toLowerCase())
  ).length;

  const requiredScore = (requiredHits / required.length) * 80;
  const preferredScore = preferred.length
    ? (preferredHits / preferred.length) * 20
    : 0;

  return Math.round(Math.min(100, requiredScore + preferredScore));
}

function findSkillGaps(candidateSkills, requiredSkills) {
  const candidateSet = toSafeLowerSet(candidateSkills);

  return toSafeArray(requiredSkills).filter(skill =>
    !candidateSet.has(String(skill).toLowerCase())
  );
}

// ──────────────────────────────────────────────────────────────
// Experience Depth
// ──────────────────────────────────────────────────────────────

function calculateExperienceDepth(experience, totalYears, roleContext = {}) {
  const safeExperience = toSafeArray(experience);
  const years = toSafeNumber(totalYears, 0);

  const minYears = toSafeNumber(roleContext.min_experience_years, 0);
  const idealYears = toSafeNumber(
    roleContext.ideal_experience_years,
    minYears + 3
  );

  let yearsScore = 0;

  if (years >= idealYears) {
    yearsScore = 50;
  } else if (years >= minYears) {
    const denominator = Math.max(1, idealYears - minYears);
    yearsScore = ((years - minYears) / denominator) * 50;
  } else {
    yearsScore = (years / Math.max(1, minYears)) * 30;
  }

  const enriched = safeExperience.filter(exp => {
    const responsibilities = toSafeArray(exp?.responsibilities);
    const achievements = toSafeArray(exp?.achievements);

    return responsibilities.length >= 2 || achievements.length >= 1;
  }).length;

  const richnessScore = safeExperience.length
    ? (enriched / safeExperience.length) * 30
    : 0;

  const avgMonths = safeExperience.length
    ? safeExperience.reduce(
        (sum, exp) => sum + toSafeNumber(exp?.duration_months, 0),
        0
      ) / safeExperience.length
    : 0;

  const tenureScore = Math.min(20, (avgMonths / 24) * 20);

  return Math.round(Math.min(100, yearsScore + richnessScore + tenureScore));
}

function attachDurations(experience) {
  return toSafeArray(experience).map(exp => {
    const start = parseDate(exp?.start_date);
    const end = exp?.end_date ? parseDate(exp.end_date) : new Date();

    const months = start ? Math.max(0, monthDiff(start, end)) : 0;

    return {
      ...exp,
      duration_months: months,
    };
  });
}

function parseDate(value) {
  if (!value || typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();

  if (normalized === 'present' || normalized === 'current') {
    return new Date();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function monthDiff(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) return 0;

  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

// ──────────────────────────────────────────────────────────────
// Education Alignment
// ──────────────────────────────────────────────────────────────

function calculateEducationAlignment(education, certifications) {
  const safeEducation = toSafeArray(education);
  const safeCertifications = toSafeArray(certifications);

  let best = 0;

  for (const edu of safeEducation) {
    const degree = String(edu?.degree || '').toLowerCase();

    for (const [keyword, points] of Object.entries(DEGREE_WEIGHTS)) {
      if (degree.includes(keyword)) {
        best = Math.max(best, points);
        break;
      }
    }
  }

  if (best === 0 && safeEducation.length) best = 25;
  if (best === 0) best = 10;

  const certBonus = Math.min(20, safeCertifications.length * 5);

  return Math.round(Math.min(100, best + certBonus));
}

// ──────────────────────────────────────────────────────────────
// Level Estimation
// ──────────────────────────────────────────────────────────────

function estimateLevel(totalYears, skillCoverage) {
  const years = toSafeNumber(totalYears, 0);
  const coverage = toSafeNumber(skillCoverage, 0);

  let level = LEVEL_THRESHOLDS[0].level;

  for (const threshold of LEVEL_THRESHOLDS) {
    if (
      years >= threshold.minYears &&
      coverage >= threshold.minSkillCoverage
    ) {
      level = threshold.level;
    }
  }

  return level;
}

function estimateLevelIfImproved(totalYears, currentCoverage) {
  const projectedCoverage = Math.min(
    100,
    toSafeNumber(currentCoverage, 0) + 25
  );

  return estimateLevel(totalYears, projectedCoverage);
}

// ──────────────────────────────────────────────────────────────
// Promotion Readiness
// ──────────────────────────────────────────────────────────────

function assessPromotionReadiness(
  skillCoverage,
  experienceDepth,
  educationAlignment
) {
  const composite = Math.round(
    toSafeNumber(skillCoverage) * 0.45 +
      toSafeNumber(experienceDepth) * 0.35 +
      toSafeNumber(educationAlignment) * 0.2
  );

  const band = PROMOTION_READINESS_BANDS.find(
    item => composite >= item.min
  );

  return band?.label || 'Early';
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  attachDurations,
  calculateSkillCoverage,
  findSkillGaps,
  calculateExperienceDepth,
  calculateEducationAlignment,
  estimateLevel,
  estimateLevelIfImproved,
  assessPromotionReadiness,
});