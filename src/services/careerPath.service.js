const careerRepo = require("../repositories/career.repository");
const readinessService = require("./readiness.service");
const promotionService = require("./promotion.service");
const timeEstimatorService = require("./timeEstimator.service");
let careerGraph = null;
try { careerGraph = require("../modules/careerGraph/CareerGraph"); } catch (_) {}

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
  // ── Try CareerGraph engine first (richer data with transitions + salary) ───
  const graphNode = careerGraph
    ? (careerGraph.getRole(roleId) || careerGraph.resolveRole(roleId))
    : null;

  if (graphNode) {
    const transitions = careerGraph.getTransitions(roleId, { minProbability: 0.1 });

    const result = {
      current_role: {
        role_id:      graphNode.role_id,
        title:        graphNode.title,
        career_level: graphNode.career_level,
        level_order:  graphNode.level_order,
        salary:       graphNode.salary || null,
      },
      next_roles:  [],
      is_terminal: graphNode.is_terminal || false,
    };

    for (const edge of transitions) {
      const nextNode = careerGraph.getRole(edge.to_role_id);
      if (!nextNode) continue;

      let readinessDetails = null;
      let readinessScore   = 1;
      let timeEstimate     = null;

      if (userProfile) {
        const syntheticRole = {
          required_skills:       nextNode.required_skills  || [],
          min_experience_years:  nextNode.min_experience_years || 0,
        };
        readinessDetails = readinessService.calculateReadiness(userProfile, syntheticRole);
        readinessScore   = readinessDetails.readiness_score;

        timeEstimate = timeEstimatorService.estimateTimeToPromotion(
          userProfile, syntheticRole, readinessDetails
        );
      }

      const growth = calculateGrowth(
        graphNode.salary?.median,
        nextNode.salary?.median,
        readinessScore
      );

      const promotionProbability =
        promotionService.calculatePromotionProbability(readinessScore);

      result.next_roles.push({
        role_id:                    nextNode.role_id,
        title:                      nextNode.title,
        career_level:               nextNode.career_level,
        level_order:                nextNode.level_order,
        salary:                     nextNode.salary || null,
        transition_type:            edge.transition_type,
        transition_probability:     edge.probability,
        years_required:             edge.years_required,
        readiness_details:          readinessDetails,
        promotion_probability_percent: promotionProbability,
        time_to_promotion:          timeEstimate,
        growth_projection:          growth,
      });
    }

    return result;
  }

  // ── Fallback: static JSON repo (legacy SE + PM families only) ────────────
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








