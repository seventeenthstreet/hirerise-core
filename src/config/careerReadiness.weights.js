/**
 * Career Readiness Scoring Configuration
 * ----------------------------------------
 * Governs:
 * - Dimension weights
 * - Deterministic scoring parameters
 * - Readiness bands
 * - Model lifecycle versioning
 *
 * PROMPT-3 RECONCILIATION (was v1.0.0):
 *   Previous config defined a 7-dimension model (skillMatch, experienceAlignment,
 *   skillDepthMaturity, marketDemandAlignment, salaryPositioning, resumeStrength,
 *   growthReadiness) that was NEVER implemented in careerHealthIndex.service.js.
 *   The live service has always computed 5 dimensions. This config now reflects
 *   reality. jobMarketDemand + careerClarity are roadmap items requiring external
 *   data sources — they will be introduced in SCORING_VERSION 2.0.0.
 */

const config = {
  // 🔄 SCORING MODEL VERSION
  // Increment when:
  // - Weight distribution changes
  // - Deterministic formulas change
  // - AI dampening logic changes
  // - Aggregation formula changes
  SCORING_VERSION: '1.1.0', // bumped: 7→5 dimension reconciliation

  // 🎯 DIMENSION WEIGHTS (Must sum to 1.0)
  // These exactly match the weights hardcoded in careerHealthIndex.service.js.
  // Both files must be updated together when weights change.
  WEIGHTS: {
    skillVelocity:    0.25, // Are skills current and growing vs market demand?
    experienceDepth:  0.20, // Is career progression strong for years of experience?
    marketAlignment:  0.25, // How well does profile match current hiring demand?
    salaryTrajectory: 0.15, // On track, underpaid, or above market?
    careerMomentum:   0.15, // Moving forward consistently — no long gaps, regular growth?
  },

  // 📊 READINESS CLASSIFICATION BANDS
  READINESS_BANDS: [
    { min: 85, label: 'Highly Ready' },
    { min: 70, label: 'Ready' },
    { min: 55, label: 'Moderately Ready' },
    { min: 40, label: 'Partially Ready' },
    { min: 0,  label: 'Not Ready' },
  ],

  // 🧠 SKILL VELOCITY PARAMETERS
  SKILL_MATCH: {
    coreSkillWeight:      0.70,
    secondarySkillWeight: 0.30,
  },

  // 📈 EXPERIENCE DEPTH PARAMETERS
  EXPERIENCE: {
    yearsFullMatchThreshold: 1.0,
    penaltyPerYearShort:     0.08,
    bonusPerYearOver:        0.03,
    overflowCap:             0.15,
  },
};


// 🔐 WEIGHT SUM VALIDATION (Enterprise Safety Check)
const totalWeight = Object.values(config.WEIGHTS)
  .reduce((sum, weight) => sum + weight, 0);

if (Math.abs(totalWeight - 1) > 0.0001) {
  throw new Error(
    `Career Readiness WEIGHTS must sum to 1. Current sum: ${totalWeight}`
  );
}

// 🛡 Freeze config to prevent runtime mutation
Object.freeze(config);
Object.freeze(config.WEIGHTS);
Object.freeze(config.SKILL_MATCH);
Object.freeze(config.EXPERIENCE);
Object.freeze(config.READINESS_BANDS);

// Canonical dimension list — import this in careerHealthIndex.service.js
// to ensure the service and config stay in sync.
const CHI_DIMENSIONS = Object.freeze(Object.keys(config.WEIGHTS));

module.exports = { ...config, CHI_DIMENSIONS };








