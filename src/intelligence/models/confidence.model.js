"use strict";

/**
 * Confidence Model
 *
 * Evaluates reliability of prioritization results.
 *
 * Confidence is NOT prediction probability.
 * It measures trustworthiness of inputs + model completeness.
 */

function calculateConfidence({
  scoredSkills,
  dependencyMap,
  careerGraphData,
  profile,
  marketData,
  config,
}) {
  const dataCoverage = calculateDataCoverage(scoredSkills, marketData);
  const gatewayCompleteness = calculateGatewayCompleteness(dependencyMap);
  const profileStrength = calculateProfileStrength(profile);
  const marketSignalStrength = calculateMarketSignalStrength(scoredSkills);

  // Weighted blend (can be tuned in config later)
  const confidenceScore =
    0.30 * dataCoverage +
    0.25 * gatewayCompleteness +
    0.25 * profileStrength +
    0.20 * marketSignalStrength;

  return {
    confidenceScore: parseFloat(confidenceScore.toFixed(2)),
    confidenceLevel: classifyConfidence(confidenceScore),
    factors: {
      dataCoverage: round(dataCoverage),
      gatewayCompleteness: round(gatewayCompleteness),
      profileStrength: round(profileStrength),
      marketSignalStrength: round(marketSignalStrength),
    },
  };
}

// ─────────────────────────────────────────────
// FACTOR 1 — DATA COVERAGE
// How many skills used real market data vs defaults?
// ─────────────────────────────────────────────

function calculateDataCoverage(scoredSkills, marketData) {
  if (!scoredSkills.length) return 0;

  let realDataCount = 0;

  for (const skill of scoredSkills) {
    if (
      marketData?.[skill.skillId]?.demandScore !== undefined &&
      marketData?.[skill.skillId]?.promotionBoost !== undefined
    ) {
      realDataCount++;
    }
  }

  return (realDataCount / scoredSkills.length) * 100;
}

// ─────────────────────────────────────────────
// FACTOR 2 — GATEWAY COMPLETENESS
// Are transition skills weighted & structured?
// ─────────────────────────────────────────────

function calculateGatewayCompleteness(dependencyMap) {
  if (!dependencyMap || !dependencyMap.totalGatewayWeight) {
    return 50; // neutral fallback
  }

  if (dependencyMap.totalGatewayWeight === 0) {
    return 40; // weak transition mapping
  }

  return 90; // strong weighted transition model present
}

// ─────────────────────────────────────────────
// FACTOR 3 — PROFILE STRENGTH
// Resume + experience completeness
// ─────────────────────────────────────────────

function calculateProfileStrength(profile) {
  const resumeScore = profile.resumeScore ?? 50;
  const experienceScore = Math.min(100, (profile.experienceYears / 15) * 100);

  return (resumeScore * 0.6) + (experienceScore * 0.4);
}

// ─────────────────────────────────────────────
// FACTOR 4 — MARKET SIGNAL STRENGTH
// Average demand signal strength
// ─────────────────────────────────────────────

function calculateMarketSignalStrength(scoredSkills) {
  if (!scoredSkills.length) return 0;

  const avgDemand =
    scoredSkills.reduce((sum, s) => sum + s.marketDemandScore, 0) /
    scoredSkills.length;

  return avgDemand;
}

// ─────────────────────────────────────────────
// CLASSIFIER
// ─────────────────────────────────────────────

function classifyConfidence(score) {
  if (score >= 80) return "HIGH";
  if (score >= 60) return "MEDIUM";
  return "LOW";
}

function round(num) {
  return parseFloat(num.toFixed(1));
}

module.exports = {
  calculateConfidence,
};
