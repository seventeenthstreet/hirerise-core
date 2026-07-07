'use strict';

/**
 * src/modules/jobMatchPremium/utils/tierClassifier.js
 *
 * Engine 2 — Tier Classifier
 *
 * Classifies a numeric match score (0–100) into a human tier label.
 *
 * Tiers:
 *   >= 75  → HIGH
 *   50–74  → MEDIUM
 *   25–49  → LOW
 *   < 25   → NO_DATA
 *
 * Pure function — no side effects, no DB calls.
 */

const TIERS = Object.freeze({
  HIGH:    'HIGH',
  MEDIUM:  'MEDIUM',
  LOW:     'LOW',
  NO_DATA: 'NO_DATA',
});

/**
 * Classifies a match score into a tier.
 *
 * @param {number} rawScore - Raw match score, any numeric value
 * @returns {{ matchScore: number, tier: string }}
 */
function classifyTier(rawScore) {
  const matchScore = Math.max(0, Math.min(100, Math.round(Number(rawScore) || 0)));

  let tier;
  if (matchScore >= 75) {
    tier = TIERS.HIGH;
  } else if (matchScore >= 50) {
    tier = TIERS.MEDIUM;
  } else if (matchScore >= 25) {
    tier = TIERS.LOW;
  } else {
    tier = TIERS.NO_DATA;
  }

  return { matchScore, tier };
}

module.exports = { classifyTier, TIERS };
