"use strict";

/**
 * Promotion Probability Model
 *
 * Pure intelligence module.
 * No repository access.
 * No logging.
 * No side effects.
 *
 * Responsible for:
 * - Gateway progress calculation
 * - Readiness normalization
 * - Resume normalization
 * - Experience alignment
 * - Synergy influence
 * - Blended probability
 * - Confidence scoring
 */

function calculatePromotionProbability({
  scoredSkills,
  dependencyMap,
  careerGraphData,
  profile,
  config,
}) {
  if (!careerGraphData) {
    return {
      nextRoleUnlocked: null,
      unlockProbabilityIncrease: 0,
      confidenceScore: 0,
    };
  }

  // ─────────────────────────────────────────────
  // 1️⃣ Gateway Progress (Weighted)
  // ─────────────────────────────────────────────
  let acquiredWeight = 0;

  for (const skill of scoredSkills) {
    if (skill.priorityLevel === "HIGH") {
      acquiredWeight +=
        dependencyMap.gatewayWeightMap?.[skill.skillId] ?? 0;
    }
  }

  const totalGatewayWeight =
    dependencyMap.totalGatewayWeight ?? 0;

  const gatewayProgress =
    totalGatewayWeight > 0
      ? acquiredWeight / totalGatewayWeight
      : 0;

  // ─────────────────────────────────────────────
  // 2️⃣ Readiness Score (Average Priority)
  // ─────────────────────────────────────────────
  const avgPriority =
    scoredSkills.reduce((sum, s) => sum + s.priorityScore, 0) /
    (scoredSkills.length || 1);

  const normalizedReadiness = avgPriority / 100;

  // ─────────────────────────────────────────────
  // 3️⃣ Resume Normalization
  // ─────────────────────────────────────────────
  const normalizedResume =
    (profile.resumeScore ?? 0) / 100;

  // ─────────────────────────────────────────────
  // 4️⃣ Experience Alignment
  // ─────────────────────────────────────────────
  const requiredExperience =
    careerGraphData.requiredExperienceYears ??
    profile.experienceYears;

  const experienceAlignment =
    requiredExperience > 0
      ? Math.min(
          1,
          profile.experienceYears / requiredExperience
        )
      : 1;

  // ─────────────────────────────────────────────
  // 5️⃣ Skill Synergy Boost
  // ─────────────────────────────────────────────
  const strongSkillsCount = scoredSkills.filter(
    (s) =>
      s.currentProficiency >=
      config.synergy.strongProficiencyThreshold
  ).length;

  const synergyBoost = Math.min(
    config.synergy.maxSynergyBoost,
    strongSkillsCount *
      config.synergy.relatedSkillBoostWeight
  );

  // ─────────────────────────────────────────────
  // 6️⃣ Blended Probability
  // ─────────────────────────────────────────────
  const blendedProbability =
    config.promotionModel.gatewayProgressWeight *
      gatewayProgress +
    config.promotionModel.readinessWeight *
      normalizedReadiness +
    config.promotionModel.resumeWeight *
      normalizedResume +
    config.promotionModel.experienceWeight *
      experienceAlignment +
    synergyBoost;

  const cappedProbability = Math.min(
    config.promotionModel.maxProbabilityCap,
    parseFloat((blendedProbability * 100).toFixed(1))
  );

  // ─────────────────────────────────────────────
  // 7️⃣ Confidence Score (Variance-Based)
  // ─────────────────────────────────────────────
  const variance =
    scoredSkills.reduce((sum, s) => {
      return (
        sum +
        Math.pow(s.priorityScore - avgPriority, 2)
      );
    }, 0) / (scoredSkills.length || 1);

  const confidenceScore = Math.max(
    0,
    100 - Math.min(100, variance / 2)
  );

  return {
    nextRoleUnlocked:
      careerGraphData.nextRole ?? null,
    unlockProbabilityIncrease: cappedProbability,
    confidenceScore: parseFloat(
      confidenceScore.toFixed(1)
    ),
    gatewayProgressPercent: parseFloat(
      (gatewayProgress * 100).toFixed(1)
    ),
    experienceAlignmentPercent: parseFloat(
      (experienceAlignment * 100).toFixed(1)
    ),
  };
}

module.exports = {
  calculatePromotionProbability,
};









