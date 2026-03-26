'use strict';

const ResumeGrowthService = require('../resumeGrowth/resumeGrowth.service');
const ResumeGrowthRepository = require('../resumeGrowth/resumeGrowth.repository');
const RoleRepository = require('../../repositories/RoleRepository');
const SkillRepository = require('../../repositories/SkillRepository');

const { SALARY_BANDS } = require('./growth.constants');
const {
  getSalaryBand,
  projectSkillCoverage,
  projectLevel,
  projectPromotionReadiness
} = require('./growth.utils');

/**
 * Dependencies (can later be injected via DI container)
 */
const roleRepository = new RoleRepository();
const skillRepository = new SkillRepository();
const resumeGrowthRepository = new ResumeGrowthRepository();

const resumeGrowthService = new ResumeGrowthService({
  roleRepository,
  skillRepository,
  resumeGrowthRepository,
});

/**
 * Main Growth Projection Engine
 */
exports.generateProjection = async ({
  userId,
  targetRoleId,
  years,
  currentExperienceYears
}) => {

  let baseline = null;

  // 1️⃣ Fetch baseline (safe fallback)
  if (userId) {
    try {
      baseline = await resumeGrowthService.getLatest(userId, targetRoleId);
    } catch (err) {
      baseline = null; // fallback if DB unavailable
    }
  }

  // 2️⃣ Extract baseline values with safe defaults
  const baseSkillCoverage =
    baseline?.skillCoverage?.overall ?? 0.3;

  const basePromotionScore =
    baseline?.growthSignals?.promotionReadiness?.score ?? 30;

  const baseLevel =
    baseline?.currentLevelEstimate ?? 'Junior';

  const projection = [];

  // 3️⃣ Generate yearly projection
  for (let year = 1; year <= years; year++) {

    const skillCoverage =
      projectSkillCoverage(baseSkillCoverage, year);

    const level =
      projectLevel(currentExperienceYears, year, skillCoverage);

    const promotionReadiness =
      projectPromotionReadiness(
        basePromotionScore,
        skillCoverage,
        year
      );

    const salary =
      getSalaryBand(level);

    projection.push({
      year,
      level,
      skillCoverage,
      promotionReadiness,
      estimatedSalary: salary
    });
  }

  // 4️⃣ Return structured output
  return {
    user_id: userId || 'anonymous',
    targetRoleId,
    baselineLevel: baseLevel,
    baseSkillCoverage,
    projectionYears: years,
    projection,
  };
};








