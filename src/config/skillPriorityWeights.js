'use strict';

/**
 * scoring.config.js (HARDENED)
 *
 * ✅ Validation added
 * ✅ Deep freeze
 * ✅ Safe numeric constraints
 * ✅ Future-proof
 */

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const config = {
  marketDemandWeight: 0.35,
  salaryImpactWeight: 0.30,
  promotionWeight: 0.20,
  proficiencyPenaltyWeight: 0.25,
  careerAccelerationMultiplier: 1.15,

  gapWeight: 0.35,

  highProficiencyThreshold: 80,
  weakProficiencyThreshold: 40,

  priorityBands: {
    high: { min: 70, label: "HIGH" },
    medium: { min: 40, label: "MEDIUM" },
    low: { min: 0, label: "LOW" },
  },

  roi: {
    fastGainMaxWeeks: 8,
    fastGainMinDemand: 70,
    strategicMinPromo: 60,
    longTermMinFuture: 65,
  },

  experience: {
    juniorMaxYears: 2,
    juniorCoreBoost: 0.20,
    seniorMinYears: 8,
    seniorLeadershipBoost: 0.25,
  },

  resumeScore: {
    lowThreshold: 60,
    foundationalBoost: 0.15,
  },

  skillClusters: {
    CORE: { baseWeeksMultiplier: 1.0 },
    ADJACENT: { baseWeeksMultiplier: 0.7 },
    LEADERSHIP: { baseWeeksMultiplier: 1.4 },
    TREND: { baseWeeksMultiplier: 1.2 },
  },

  learningTime: {
    baseWeeksPerGap10Points: 1.5,
    minWeeks: 1,
    maxWeeks: 52,
  },

  synergy: {
    strongProficiencyThreshold: 75,
    relatedSkillBoostWeight: 0.05,
    maxSynergyBoost: 0.20,
  },

  promotionModel: {
    gatewayProgressWeight: 0.4,
    readinessWeight: 0.25,
    resumeWeight: 0.15,
    experienceWeight: 0.20,
    maxProbabilityCap: 95,
  },

  freeUserSkillLimit: 3,
};

// ─────────────────────────────────────────────
// VALIDATION (CRITICAL)
// ─────────────────────────────────────────────

function assertNumber(name, value, min = 0, max = Infinity) {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error(`[scoring] ${name} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`[scoring] ${name} out of range (${min}-${max})`);
  }
}

function validateConfig(cfg) {
  // Weights
  assertNumber('marketDemandWeight', cfg.marketDemandWeight, 0, 1);
  assertNumber('salaryImpactWeight', cfg.salaryImpactWeight, 0, 1);
  assertNumber('promotionWeight', cfg.promotionWeight, 0, 1);
  assertNumber('proficiencyPenaltyWeight', cfg.proficiencyPenaltyWeight, 0, 1);

  // Thresholds
  assertNumber('highProficiencyThreshold', cfg.highProficiencyThreshold, 0, 100);
  assertNumber('weakProficiencyThreshold', cfg.weakProficiencyThreshold, 0, 100);

  // Learning time
  assertNumber('minWeeks', cfg.learningTime.minWeeks, 0, 52);
  assertNumber('maxWeeks', cfg.learningTime.maxWeeks, 1, 104);

  if (cfg.learningTime.minWeeks > cfg.learningTime.maxWeeks) {
    throw new Error('[scoring] minWeeks cannot exceed maxWeeks');
  }

  // Promotion model
  const p = cfg.promotionModel;
  const totalWeight =
    p.gatewayProgressWeight +
    p.readinessWeight +
    p.resumeWeight +
    p.experienceWeight;

  if (Math.abs(totalWeight - 1) > 0.001) {
    throw new Error('[scoring] promotionModel weights must sum to 1');
  }

  assertNumber('maxProbabilityCap', p.maxProbabilityCap, 0, 100);

  // Synergy
  assertNumber('maxSynergyBoost', cfg.synergy.maxSynergyBoost, 0, 1);
}

validateConfig(config);

// ─────────────────────────────────────────────
// DEEP FREEZE (IMMUTABLE)
// ─────────────────────────────────────────────

function deepFreeze(obj) {
  Object.freeze(obj);
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    if (
      obj[prop] &&
      typeof obj[prop] === 'object' &&
      !Object.isFrozen(obj[prop])
    ) {
      deepFreeze(obj[prop]);
    }
  });
  return obj;
}

deepFreeze(config);

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = config;