"use strict";

module.exports = {

  // ─────────────────────────────────────────────────────────────────────────────
  // CORE SCORING WEIGHTS
  // These are additive components (not normalized sum).
  // Each weight scales its respective contribution.
  // ─────────────────────────────────────────────────────────────────────────────
  marketDemandWeight: 0.35,
  salaryImpactWeight: 0.30,
  promotionWeight: 0.20,
  proficiencyPenaltyWeight: 0.25,        // Applied when proficiency is high
  careerAccelerationMultiplier: 1.15,    // Used in weighted gateway boost

  // ─────────────────────────────────────────────────────────────────────────────
  // GAP-BASED URGENCY BOOST
  // boostedScore = baseScore × (1 + (proficiencyGap / 100) × gapWeight)
  // ─────────────────────────────────────────────────────────────────────────────
  gapWeight: 0.35,

  // ─────────────────────────────────────────────────────────────────────────────
  // PROFICIENCY THRESHOLDS
  // ─────────────────────────────────────────────────────────────────────────────
  highProficiencyThreshold: 80,
  weakProficiencyThreshold: 40,

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIORITY SCORE BANDS
  // ─────────────────────────────────────────────────────────────────────────────
  priorityBands: {
    high: { min: 70, label: "HIGH" },
    medium: { min: 40, label: "MEDIUM" },
    low: { min: 0, label: "LOW" },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ROI CATEGORIZATION RULES
  // ─────────────────────────────────────────────────────────────────────────────
  roi: {
    fastGainMaxWeeks: 8,
    fastGainMinDemand: 70,
    strategicMinPromo: 60,
    longTermMinFuture: 65,
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // EXPERIENCE-BASED CONTEXTUAL ADJUSTMENTS
  // ─────────────────────────────────────────────────────────────────────────────
  experience: {
    juniorMaxYears: 2,
    juniorCoreBoost: 0.20,
    seniorMinYears: 8,
    seniorLeadershipBoost: 0.25,
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // RESUME SCORE CONTEXTUAL ADJUSTMENTS
  // ─────────────────────────────────────────────────────────────────────────────
  resumeScore: {
    lowThreshold: 60,
    foundationalBoost: 0.15,
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SKILL CLUSTER DEFINITIONS
  // ─────────────────────────────────────────────────────────────────────────────
  skillClusters: {
    CORE: { baseWeeksMultiplier: 1.0 },
    ADJACENT: { baseWeeksMultiplier: 0.7 },
    LEADERSHIP: { baseWeeksMultiplier: 1.4 },
    TREND: { baseWeeksMultiplier: 1.2 },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // LEARNING TIME ESTIMATION
  // ─────────────────────────────────────────────────────────────────────────────
  learningTime: {
    baseWeeksPerGap10Points: 1.5,
    minWeeks: 1,
    maxWeeks: 52,
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SKILL SYNERGY BOOST
  // Applies when user has strong related skills
  // finalScore = finalScore × (1 + synergyBoost)
  // ─────────────────────────────────────────────────────────────────────────────
  synergy: {
    strongProficiencyThreshold: 75,
    relatedSkillBoostWeight: 0.05,  // boost per strong related skill
    maxSynergyBoost: 0.20,          // cap total boost
  },
 //─────────────────────────────────────────────────────────────────────────────
  // PROMOTION PROBABILITY MODEL
  // Controls how unlock probability is blended
  // ─────────────────────────────────────────────────────────────────────────────
  promotionModel: {
    gatewayProgressWeight: 0.4,
    readinessWeight: 0.25,
    resumeWeight: 0.15,
    experienceWeight: 0.20,
    maxProbabilityCap: 95,
  },
  // ─────────────────────────────────────────────────────────────────────────────
  // PREMIUM GATING
  // ─────────────────────────────────────────────────────────────────────────────
  freeUserSkillLimit: 3,
};
