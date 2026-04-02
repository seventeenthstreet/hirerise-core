'use strict';

/**
 * Confidence Model (Production Optimized)
 */

function calculateConfidence({
  scoredSkills = [],
  dependencyMap = {},
  careerGraphData = {},
  profile = {},
  marketData = {},
  config = {}
}) {
  const weights = {
    dataCoverage: config?.weights?.dataCoverage ?? 0.30,
    gatewayCompleteness: config?.weights?.gatewayCompleteness ?? 0.25,
    profileStrength: config?.weights?.profileStrength ?? 0.25,
    marketSignalStrength: config?.weights?.marketSignalStrength ?? 0.20
  };

  const dataCoverage = safe(calculateDataCoverage(scoredSkills, marketData));
  const gatewayCompleteness = safe(calculateGatewayCompleteness(dependencyMap));
  const profileStrength = safe(calculateProfileStrength(profile));
  const marketSignalStrength = safe(calculateMarketSignalStrength(scoredSkills));

  const confidenceScore =
    weights.dataCoverage * dataCoverage +
    weights.gatewayCompleteness * gatewayCompleteness +
    weights.profileStrength * profileStrength +
    weights.marketSignalStrength * marketSignalStrength;

  return {
    confidenceScore: round(confidenceScore),
    confidenceLevel: classifyConfidence(confidenceScore),
    factors: {
      dataCoverage: round(dataCoverage),
      gatewayCompleteness: round(gatewayCompleteness),
      profileStrength: round(profileStrength),
      marketSignalStrength: round(marketSignalStrength)
    },
    meta: {
      weights,
      evaluatedAt: new Date().toISOString()
    }
  };
}

// ─────────────────────────────────────────────
// FACTOR 1 — DATA COVERAGE
// ─────────────────────────────────────────────

function calculateDataCoverage(scoredSkills, marketData) {
  if (!scoredSkills.length) return 0;

  let realDataCount = 0;

  for (const skill of scoredSkills) {
    const data = marketData?.[skill.skillId];

    if (
      data &&
      isValidNumber(data.demandScore) &&
      isValidNumber(data.promotionBoost)
    ) {
      realDataCount++;
    }
  }

  return (realDataCount / scoredSkills.length) * 100;
}

// ─────────────────────────────────────────────
// FACTOR 2 — GATEWAY COMPLETENESS (IMPROVED)
// ─────────────────────────────────────────────

function calculateGatewayCompleteness(dependencyMap) {
  if (!dependencyMap) return 50;

  const total = dependencyMap.totalGatewayWeight ?? 0;
  const maxExpected = dependencyMap.maxPossibleWeight ?? 100;

  if (maxExpected === 0) return 50;

  const ratio = total / maxExpected;

  return clamp(ratio * 100);
}

// ─────────────────────────────────────────────
// FACTOR 3 — PROFILE STRENGTH
// ─────────────────────────────────────────────

function calculateProfileStrength(profile) {
  const resumeScore = safe(profile.resumeScore ?? 50);
  const experienceYears = safe(profile.experienceYears ?? 0);

  const experienceScore = clamp((experienceYears / 15) * 100);

  return (resumeScore * 0.6) + (experienceScore * 0.4);
}

// ─────────────────────────────────────────────
// FACTOR 4 — MARKET SIGNAL STRENGTH
// ─────────────────────────────────────────────

function calculateMarketSignalStrength(scoredSkills) {
  if (!scoredSkills.length) return 0;

  const validScores = scoredSkills
    .map(s => s.marketDemandScore)
    .filter(isValidNumber);

  if (!validScores.length) return 0;

  const avg =
    validScores.reduce((sum, val) => sum + val, 0) / validScores.length;

  return clamp(avg);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function classifyConfidence(score) {
  if (score >= 80) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  return 'LOW';
}

function round(num) {
  return parseFloat(num.toFixed(2));
}

function clamp(num) {
  if (!isValidNumber(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

function safe(num) {
  return isValidNumber(num) ? num : 0;
}

function isValidNumber(val) {
  return typeof val === 'number' && !isNaN(val);
}

module.exports = {
  calculateConfidence
};