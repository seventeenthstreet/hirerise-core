'use strict';

/**
 * Career Readiness Scoring Configuration (HARDENED)
 *
 * ✅ Deep freeze
 * ✅ Schema validation
 * ✅ Weight normalization guard
 * ✅ Version enforcement ready
 * ✅ Immutable dimension contract
 */

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const config = {
  SCORING_VERSION: '1.1.0',

  WEIGHTS: {
    skillVelocity:    0.25,
    experienceDepth:  0.20,
    marketAlignment:  0.25,
    salaryTrajectory: 0.15,
    careerMomentum:   0.15,
  },

  READINESS_BANDS: [
    { min: 85, label: 'Highly Ready' },
    { min: 70, label: 'Ready' },
    { min: 55, label: 'Moderately Ready' },
    { min: 40, label: 'Partially Ready' },
    { min: 0,  label: 'Not Ready' },
  ],

  SKILL_MATCH: {
    coreSkillWeight:      0.70,
    secondarySkillWeight: 0.30,
  },

  EXPERIENCE: {
    yearsFullMatchThreshold: 1.0,
    penaltyPerYearShort:     0.08,
    bonusPerYearOver:        0.03,
    overflowCap:             0.15,
  },
};

// ─────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────

function validateConfig(cfg) {
  // ── Weight Type Check ──
  for (const [key, value] of Object.entries(cfg.WEIGHTS)) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`Invalid weight for ${key}: must be a number`);
    }
  }

  // ── Weight Sum Check ──
  const totalWeight = Object.values(cfg.WEIGHTS)
    .reduce((sum, w) => sum + w, 0);

  if (Math.abs(totalWeight - 1) > 0.0001) {
    throw new Error(
      `WEIGHTS must sum to 1. Current sum: ${totalWeight}`
    );
  }

  // ── Readiness Bands Order Check ──
  for (let i = 1; i < cfg.READINESS_BANDS.length; i++) {
    if (cfg.READINESS_BANDS[i].min > cfg.READINESS_BANDS[i - 1].min) {
      throw new Error('READINESS_BANDS must be sorted descending by min');
    }
  }

  // ── Skill Match Check ──
  const sm = cfg.SKILL_MATCH;
  if (Math.abs(sm.coreSkillWeight + sm.secondarySkillWeight - 1) > 0.0001) {
    throw new Error('SKILL_MATCH weights must sum to 1');
  }
}

validateConfig(config);

// ─────────────────────────────────────────────────────────────
// DIMENSIONS CONTRACT (CRITICAL)
// ─────────────────────────────────────────────────────────────

const CHI_DIMENSIONS = Object.freeze(Object.keys(config.WEIGHTS));

// ─────────────────────────────────────────────────────────────
// DEEP FREEZE (IMMUTABILITY GUARANTEE)
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// VERSION GUARD (OPTIONAL BUT POWERFUL)
// ─────────────────────────────────────────────────────────────

function assertVersion(expectedVersion) {
  if (config.SCORING_VERSION !== expectedVersion) {
    throw new Error(
      `Scoring version mismatch: expected ${expectedVersion}, got ${config.SCORING_VERSION}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  ...config,
  CHI_DIMENSIONS,
  assertVersion,
};