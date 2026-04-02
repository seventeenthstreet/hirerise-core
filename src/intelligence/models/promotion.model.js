'use strict';

/**
 * Promotion Probability Model (Production Optimized)
 */

function calculatePromotionProbability({
  scoredSkills = [],
  dependencyMap = {},
  careerGraphData = {},
  profile = {},
  config = {},
}) {
  if (!careerGraphData) {
    return baseFallback();
  }

  const promotionConfig = config.promotionModel || {};
  const synergyConfig = config.synergy || {};

  // ─────────────────────────────────────────────
  // 1️⃣ Gateway Progress
  // ─────────────────────────────────────────────

  let acquiredWeight = 0;

  for (const skill of scoredSkills) {
    if (skill.priorityLevel === 'HIGH') {
      acquiredWeight +=
        dependencyMap.gatewayWeightMap?.[skill.skillId] ?? 0;
    }
  }

  const totalGatewayWeight = dependencyMap.totalGatewayWeight ?? 0;

  const gatewayProgress =
    totalGatewayWeight > 0
      ? clamp(acquiredWeight / totalGatewayWeight, 0, 1)
      : 0;

  // ─────────────────────────────────────────────
  // 2️⃣ Readiness Score
  // ─────────────────────────────────────────────

  const validScores = scoredSkills
    .map(s => s.priorityScore)
    .filter(isValidNumber);

  const avgPriority =
    validScores.reduce((sum, v) => sum + v, 0) /
    (validScores.length || 1);

  const normalizedReadiness = clamp(avgPriority / 100, 0, 1);

  // ─────────────────────────────────────────────
  // 3️⃣ Resume
  // ─────────────────────────────────────────────

  const normalizedResume = clamp(
    (profile.resumeScore ?? 0) / 100,
    0,
    1
  );

  // ─────────────────────────────────────────────
  // 4️⃣ Experience
  // ─────────────────────────────────────────────

  const requiredExperience =
    careerGraphData.requiredExperienceYears ??
    profile.experienceYears ?? 1;

  const experienceAlignment =
    requiredExperience > 0
      ? clamp(
          profile.experienceYears / requiredExperience,
          0,
          1
        )
      : 1;

  // ─────────────────────────────────────────────
  // 5️⃣ Synergy Boost (CAPPED & NORMALIZED)
  // ─────────────────────────────────────────────

  const strongThreshold =
    synergyConfig.strongProficiencyThreshold ?? 70;

  const maxBoost = synergyConfig.maxSynergyBoost ?? 0.1;
  const weight = synergyConfig.relatedSkillBoostWeight ?? 0.02;

  const strongSkillsCount = scoredSkills.filter(
    s => (s.currentProficiency ?? 0) >= strongThreshold
  ).length;

  const synergyBoost = clamp(
    strongSkillsCount * weight,
    0,
    maxBoost
  );

  // ─────────────────────────────────────────────
  // 6️⃣ Blended Probability
  // ─────────────────────────────────────────────

  const blendedProbability =
    (promotionConfig.gatewayProgressWeight ?? 0.3) * gatewayProgress +
    (promotionConfig.readinessWeight ?? 0.25) * normalizedReadiness +
    (promotionConfig.resumeWeight ?? 0.2) * normalizedResume +
    (promotionConfig.experienceWeight ?? 0.15) * experienceAlignment +
    synergyBoost;

  const cappedProbability = clamp(
    blendedProbability * 100,
    0,
    promotionConfig.maxProbabilityCap ?? 95
  );

  // ─────────────────────────────────────────────
  // 7️⃣ Confidence (IMPROVED)
  // ─────────────────────────────────────────────

  const variance =
    validScores.reduce(
      (sum, v) => sum + Math.pow(v - avgPriority, 2),
      0
    ) / (validScores.length || 1);

  const normalizedVariance = clamp(variance / 1000, 0, 1);

  const confidenceScore = (1 - normalizedVariance) * 100;

  return {
    nextRoleUnlocked: careerGraphData.nextRole ?? null,
    unlockProbabilityIncrease: round(cappedProbability),
    confidenceScore: round(confidenceScore),

    gatewayProgressPercent: round(gatewayProgress * 100),
    experienceAlignmentPercent: round(experienceAlignment * 100),

    meta: {
      evaluatedAt: new Date().toISOString(),
      factors: {
        gatewayProgress,
        readiness: normalizedReadiness,
        resume: normalizedResume,
        experience: experienceAlignment,
        synergyBoost,
      },
    },
  };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round(val) {
  return parseFloat(val.toFixed(1));
}

function isValidNumber(val) {
  return typeof val === 'number' && !isNaN(val);
}

function baseFallback() {
  return {
    nextRoleUnlocked: null,
    unlockProbabilityIncrease: 0,
    confidenceScore: 0,
  };
}

module.exports = {
  calculatePromotionProbability,
};