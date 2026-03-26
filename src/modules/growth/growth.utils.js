'use strict';

const { SALARY_BANDS } = require('./growth.constants');

exports.getSalaryBand = (level) => {
  return SALARY_BANDS[(level || '').toLowerCase()] || SALARY_BANDS.junior;
};

exports.projectSkillCoverage = (baseCoverage, year) => {
  return Math.round(Math.min(1.0, baseCoverage + year * 0.08) * 100) / 100;
};

exports.projectLevel = (baseYears, yearsAdded, skillCoverage) => {
  const totalYears = baseYears + yearsAdded;

  if (totalYears >= 10 && skillCoverage >= 0.85) return 'Principal';
  if (totalYears >= 7  && skillCoverage >= 0.75) return 'Lead';
  if (totalYears >= 4  && skillCoverage >= 0.6)  return 'Senior';
  if (totalYears >= 2  && skillCoverage >= 0.4)  return 'Mid';

  return 'Junior';
};

exports.projectPromotionReadiness = (
  baseReadiness,
  skillCoverage,
  yearsAdded
) => {

  const score = Math.min(
    100,
    Math.round(
      baseReadiness +
      (skillCoverage * 25) +
      (yearsAdded * 3)
    )
  );

  if (score >= 80) return { score, label: 'Ready' };
  if (score >= 55) return { score, label: 'On Track' };

  return { score, label: 'Needs Work' };
};









