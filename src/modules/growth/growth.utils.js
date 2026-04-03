'use strict';

const { SALARY_BANDS } = require('./growth.constants');

/**
 * Immutable growth thresholds
 * Keeps promotion logic centralized and maintainable.
 */
const LEVEL_THRESHOLDS = Object.freeze([
  { minYears: 10, minCoverage: 0.85, level: 'Principal' },
  { minYears: 7, minCoverage: 0.75, level: 'Lead' },
  { minYears: 4, minCoverage: 0.6, level: 'Senior' },
  { minYears: 2, minCoverage: 0.4, level: 'Mid' }
]);

/**
 * Normalize numeric values safely.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Resolve salary band by level.
 *
 * @param {string} level
 * @returns {*}
 */
exports.getSalaryBand = (level) => {
  const normalizedLevel = String(level || 'junior').toLowerCase();
  return SALARY_BANDS[normalizedLevel] || SALARY_BANDS.junior;
};

/**
 * Project skill growth over time.
 *
 * Preserves existing 8% yearly progression logic.
 *
 * @param {number} baseCoverage
 * @param {number} year
 * @returns {number}
 */
exports.projectSkillCoverage = (baseCoverage, year) => {
  const safeBaseCoverage = Math.max(0, Math.min(1, toNumber(baseCoverage, 0)));
  const safeYear = Math.max(0, toNumber(year, 0));

  const projected = Math.min(1, safeBaseCoverage + (safeYear * 0.08));

  return Math.round(projected * 100) / 100;
};

/**
 * Project user seniority level.
 *
 * @param {number} baseYears
 * @param {number} yearsAdded
 * @param {number} skillCoverage
 * @returns {string}
 */
exports.projectLevel = (baseYears, yearsAdded, skillCoverage) => {
  const totalYears =
    Math.max(0, toNumber(baseYears, 0)) +
    Math.max(0, toNumber(yearsAdded, 0));

  const safeCoverage = Math.max(
    0,
    Math.min(1, toNumber(skillCoverage, 0))
  );

  const matchedLevel = LEVEL_THRESHOLDS.find(
    ({ minYears, minCoverage }) =>
      totalYears >= minYears &&
      safeCoverage >= minCoverage
  );

  return matchedLevel?.level || 'Junior';
};

/**
 * Project promotion readiness.
 *
 * Preserves:
 * - skill contribution
 * - yearly growth bonus
 * - label thresholds
 *
 * @param {number} baseReadiness
 * @param {number} skillCoverage
 * @param {number} yearsAdded
 * @returns {{score:number,label:string}}
 */
exports.projectPromotionReadiness = (
  baseReadiness,
  skillCoverage,
  yearsAdded
) => {
  const safeReadiness = Math.max(0, toNumber(baseReadiness, 0));
  const safeCoverage = Math.max(
    0,
    Math.min(1, toNumber(skillCoverage, 0))
  );
  const safeYearsAdded = Math.max(0, toNumber(yearsAdded, 0));

  const score = Math.min(
    100,
    Math.round(
      safeReadiness +
      (safeCoverage * 25) +
      (safeYearsAdded * 3)
    )
  );

  if (score >= 80) {
    return { score, label: 'Ready' };
  }

  if (score >= 55) {
    return { score, label: 'On Track' };
  }

  return { score, label: 'Needs Work' };
};