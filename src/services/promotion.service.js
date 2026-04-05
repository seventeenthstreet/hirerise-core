'use strict';

/**
 * @file src/services/promotion.service.js
 * @description
 * Converts readiness score (0–1) into a promotion probability percentage.
 *
 * Features:
 * - strict numeric safety
 * - bounded 0–100 output
 * - deterministic clamping
 * - maintainable threshold constants
 */

const LOW_THRESHOLD = 0.5;
const HIGH_THRESHOLD = 0.8;

const LOW_MULTIPLIER = 0.7;
const MID_MULTIPLIER = 0.85;
const HIGH_MULTIPLIER = 0.95;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getMultiplier(score) {
  if (score < LOW_THRESHOLD) return LOW_MULTIPLIER;
  if (score < HIGH_THRESHOLD) return MID_MULTIPLIER;
  return HIGH_MULTIPLIER;
}

function calculatePromotionProbability(readinessScore) {
  const score = Number(readinessScore);

  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }

  const normalizedScore = clamp(score, 0, 1);
  const multiplier = getMultiplier(normalizedScore);
  const probability = normalizedScore * multiplier * 100;

  return clamp(Math.round(probability), 0, 100);
}

module.exports = {
  calculatePromotionProbability,
};