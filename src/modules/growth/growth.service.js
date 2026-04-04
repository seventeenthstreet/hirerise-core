'use strict';

const ResumeGrowthService = require('../resumeGrowth/resumeGrowth.service');
const ResumeGrowthRepository = require('../resumeGrowth/resumeGrowth.repository');
const RoleRepository = require('../../repositories/RoleRepository');
const skillRepository = require('../../repositories/skillRepository');
const logger = require('../../utils/logger');

const {
  getSalaryBand,
  projectSkillCoverage,
  projectLevel,
  projectPromotionReadiness
} = require('./growth.utils');

/**
 * Singleton dependency graph
 * Reused across requests for better performance and stable DB connection reuse.
 */
const dependencies = Object.freeze({
  roleRepository: new RoleRepository(),
  skillRepository: new skillRepository(),
  resumeGrowthRepository: new ResumeGrowthRepository()
});

const resumeGrowthService = new ResumeGrowthService(dependencies);

/**
 * Normalize and sanitize inputs.
 *
 * @param {object} params
 * @returns {{
 *   userId: string|null,
 *   targetRoleId: string|null,
 *   years: number,
 *   currentExperienceYears: number
 * }}
 */
function normalizeInputs({
  userId,
  targetRoleId,
  years,
  currentExperienceYears
}) {
  return {
    userId: userId || null,
    targetRoleId: targetRoleId || null,
    years: Math.max(1, Number.parseInt(years, 10) || 1),
    currentExperienceYears: Math.max(
      0,
      Number(currentExperienceYears) || 0
    )
  };
}

/**
 * Fetch latest baseline safely.
 * Preserves previous graceful fallback behavior.
 *
 * @param {string|null} userId
 * @param {string|null} targetRoleId
 * @returns {Promise<object|null>}
 */
async function getBaseline(userId, targetRoleId) {
  if (!userId) return null;

  try {
    return await resumeGrowthService.getLatest(userId, targetRoleId);
  } catch (error) {
    logger.warn('Growth baseline fetch failed, using fallback defaults', {
      module: 'growth.service',
      userId,
      targetRoleId,
      error: error.message
    });

    return null;
  }
}

/**
 * Main Growth Projection Engine
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} [params.targetRoleId]
 * @param {number} [params.years]
 * @param {number} [params.currentExperienceYears]
 *
 * @returns {Promise<object>}
 */
exports.generateProjection = async (params) => {
  const {
    userId,
    targetRoleId,
    years,
    currentExperienceYears
  } = normalizeInputs(params);

  const baseline = await getBaseline(userId, targetRoleId);

  const baseSkillCoverage =
    baseline?.skillCoverage?.overall ?? 0.3;

  const basePromotionScore =
    baseline?.growthSignals?.promotionReadiness?.score ?? 30;

  const baseLevel =
    baseline?.currentLevelEstimate ?? 'Junior';

  const projection = Array.from({ length: years }, (_, index) => {
    const year = index + 1;

    const skillCoverage =
      projectSkillCoverage(baseSkillCoverage, year);

    const level =
      projectLevel(
        currentExperienceYears,
        year,
        skillCoverage
      );

    const promotionReadiness =
      projectPromotionReadiness(
        basePromotionScore,
        skillCoverage,
        year
      );

    return {
      year,
      level,
      skillCoverage,
      promotionReadiness,
      estimatedSalary: getSalaryBand(level)
    };
  });

  return {
    user_id: userId || 'anonymous',
    targetRoleId,
    baselineLevel: baseLevel,
    baseSkillCoverage,
    projectionYears: years,
    projection
  };
};