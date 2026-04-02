'use strict';

/**
 * adaptiveWeight.utils.js
 *
 * Production-grade utilities for Adaptive Weight Engine
 * - Ensures weights ALWAYS sum to 1.0
 * - Enforces bounds
 * - Prevents floating-point drift
 * - Guards against invalid inputs
 */

const logger = require('../../utils/logger');
const {
  WEIGHT_BOUNDS,
  DEFAULT_WEIGHTS,
} = require('./adaptiveWeight.constants');

// ─────────────────────────────────────────────────────────────
// 🔹 Constants
// ─────────────────────────────────────────────────────────────
const PRECISION = 6; // decimal places
const EPSILON = 1e-6;

// ─────────────────────────────────────────────────────────────
// 🔹 Clamp value within bounds
// ─────────────────────────────────────────────────────────────
function clamp(value, min, max) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

// ─────────────────────────────────────────────────────────────
// 🔹 Round to fixed precision
// ─────────────────────────────────────────────────────────────
function round(value) {
  return Number(value.toFixed(PRECISION));
}

// ─────────────────────────────────────────────────────────────
// 🔹 Validate structure
// ─────────────────────────────────────────────────────────────
function validateWeights(weights) {
  if (!weights || typeof weights !== 'object') return false;

  const requiredKeys = Object.keys(DEFAULT_WEIGHTS);

  for (const key of requiredKeys) {
    if (!(key in weights)) return false;

    const val = weights[key];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return false;
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// 🔹 Normalize weights → sum = 1.0
// ─────────────────────────────────────────────────────────────
function normalizeWeights(inputWeights) {
  try {
    // Step 0: Validate
    if (!validateWeights(inputWeights)) {
      logger.warn('[AdaptiveWeights] Invalid weights input → using defaults');
      return { ...DEFAULT_WEIGHTS };
    }

    const keys = Object.keys(DEFAULT_WEIGHTS);

    // Step 1: Clamp
    const clamped = {};
    for (const key of keys) {
      clamped[key] = clamp(
        inputWeights[key],
        WEIGHT_BOUNDS.min,
        WEIGHT_BOUNDS.max
      );
    }

    // Step 2: Sum
    let total = Object.values(clamped).reduce((sum, v) => sum + v, 0);

    // Step 3: Handle zero/invalid total
    if (!total || total <= 0) {
      logger.error('[AdaptiveWeights] Total weight invalid → fallback to defaults');
      return { ...DEFAULT_WEIGHTS };
    }

    // Step 4: Normalize
    const normalized = {};
    for (const key of keys) {
      normalized[key] = clamped[key] / total;
    }

    // Step 5: Fix floating drift
    let sum = Object.values(normalized).reduce((a, b) => a + b, 0);
    let diff = 1 - sum;

    if (Math.abs(diff) > EPSILON) {
      // Adjust largest weight
      const maxKey = keys.reduce((a, b) =>
        normalized[a] > normalized[b] ? a : b
      );
      normalized[maxKey] += diff;
    }

    // Step 6: Final rounding
    const finalWeights = {};
    for (const key of keys) {
      finalWeights[key] = round(normalized[key]);
    }

    // Step 7: Final safety check
    const finalSum = Object.values(finalWeights).reduce((a, b) => a + b, 0);

    if (Math.abs(finalSum - 1) > 0.001) {
      logger.error('[AdaptiveWeights] Final normalization drift detected → fallback');
      return { ...DEFAULT_WEIGHTS };
    }

    return finalWeights;

  } catch (err) {
    logger.error('[AdaptiveWeights] normalizeWeights failed', err);
    return { ...DEFAULT_WEIGHTS };
  }
}

// ─────────────────────────────────────────────────────────────
// 🔹 Apply learning update (safe adjustment)
// ─────────────────────────────────────────────────────────────
function applyWeightShift(weights, deltas) {
  try {
    if (!validateWeights(weights)) return { ...DEFAULT_WEIGHTS };

    const updated = {};

    for (const key of Object.keys(DEFAULT_WEIGHTS)) {
      const delta = deltas?.[key] || 0;
      updated[key] = weights[key] + delta;
    }

    return normalizeWeights(updated);

  } catch (err) {
    logger.error('[AdaptiveWeights] applyWeightShift failed', err);
    return { ...DEFAULT_WEIGHTS };
  }
}

// ─────────────────────────────────────────────────────────────
// 🔹 Ensure weights already valid (fast path)
// ─────────────────────────────────────────────────────────────
function ensureValidWeights(weights) {
  if (!validateWeights(weights)) {
    return { ...DEFAULT_WEIGHTS };
  }

  const sum = Object.values(weights).reduce((a, b) => a + b, 0);

  if (Math.abs(sum - 1) > EPSILON) {
    return normalizeWeights(weights);
  }

  return weights;
}

// ─────────────────────────────────────────────────────────────
// 🔹 Exports
// ─────────────────────────────────────────────────────────────
module.exports = Object.freeze({
  normalizeWeights,
  applyWeightShift,
  ensureValidWeights,
  validateWeights,
});
