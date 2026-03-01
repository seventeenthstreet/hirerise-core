const careerRepo = require("../repositories/career.repository");
const readinessService = require("./readiness.service");
const promotionService = require("./promotion.service");
const timeEstimatorService = require("./timeEstimator.service");

function calculateGrowth(currentSalaryMedian, nextSalaryMedian, readiness = 1) {
  if (!currentSalaryMedian || !nextSalaryMedian) return null;

  const rawDelta = nextSalaryMedian - currentSalaryMedian;
  const adjustedDelta = Math.round(rawDelta * readiness);

  const growthPercent = ((adjustedDelta / currentSalaryMedian) * 100).toFixed(2);

  return {
    raw_salary_delta: rawDelta,
    adjusted_salary_delta: adjustedDelta,
    growth_percent: parseFloat(growthPercent),
    readiness_score: readiness
  };
}

function getCareerPath(roleId, userProfile = null) {
  const currentRole = careerRepo.getRole(roleId);

  if (!currentRole) {
    throw new Error(`Role ${roleId} not found`);
  }

  const nextRoles = careerRepo.getNextRoles(roleId);

  const result = {
    current_role: {
      role_id: currentRole.role_id,
      title: currentRole.title,
      career_level: currentRole.career_level,
      level_order: currentRole.level_order,
      salary: currentRole.salary || null
    },
    next_roles: [],
    is_terminal: currentRole.is_terminal
  };

  nextRoles.forEach((nextRole) => {
    if (!nextRole) return;

    let readinessDetails = null;
    let readinessScore = 1;
    let timeEstimate = null;

    if (userProfile) {
      readinessDetails = readinessService.calculateReadiness(
        userProfile,
        nextRole
      );
      readinessScore = readinessDetails.readiness_score;

      timeEstimate = timeEstimatorService.estimateTimeToPromotion(
        userProfile,
        nextRole,
        readinessDetails
      );
    }

    const growth = calculateGrowth(
      currentRole.salary?.median,
      nextRole.salary?.median,
      readinessScore
    );

    const promotionProbability =
      promotionService.calculatePromotionProbability(readinessScore);

    result.next_roles.push({
      role_id: nextRole.role_id,
      title: nextRole.title,
      career_level: nextRole.career_level,
      level_order: nextRole.level_order,
      salary: nextRole.salary || null,
      readiness_details: readinessDetails,
      promotion_probability_percent: promotionProbability,
      time_to_promotion: timeEstimate,
      growth_projection: growth
    });
  });

  return result;
}

module.exports = {
  getCareerPath
};
