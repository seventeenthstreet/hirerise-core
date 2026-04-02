'use strict';

/**
 * adaptiveWeight.validator.js
 *
 * Production-grade validation + sanitization
 */

const {
  VALID_EXPERIENCE_BUCKETS,
  WEIGHT_BOUNDS,
  OUTCOME,
  DEFAULT_WEIGHTS,
} = require('./adaptiveWeight.constants');

// ─────────────────────────────────────────────────────────────
// 🔹 Helpers
// ─────────────────────────────────────────────────────────────

function normalizeString(value) {
  return value.trim().toLowerCase();
}

function isValidNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function throwValidation(errors) {
  const err = new Error(errors.join(' | '));
  err.name = 'AdaptiveWeightValidationError';
  err.statusCode = 422;
  err.details = errors;
  throw err;
}

// ─────────────────────────────────────────────────────────────
// 🔑 Validate Key (WITH SANITIZATION)
// ─────────────────────────────────────────────────────────────

function validateWeightKey(input) {
  const errors = [];

  let { roleFamily, experienceBucket, industryTag } = input;

  if (!roleFamily || typeof roleFamily !== 'string') {
    errors.push('roleFamily must be a non-empty string.');
  }

  if (!industryTag || typeof industryTag !== 'string') {
    errors.push('industryTag must be a non-empty string.');
  }

  if (!VALID_EXPERIENCE_BUCKETS.includes(experienceBucket)) {
    errors.push(
      `experienceBucket must be one of: ${VALID_EXPERIENCE_BUCKETS.join(', ')}.`
    );
  }

  if (errors.length > 0) throwValidation(errors);

  // ✅ SANITIZED OUTPUT
  return {
    roleFamily: normalizeString(roleFamily),
    experienceBucket,
    industryTag: normalizeString(industryTag),
  };
}

// ─────────────────────────────────────────────────────────────
// 📥 Validate Outcome Payload
// ─────────────────────────────────────────────────────────────

function validateOutcomePayload(input) {
  const errors = [];

  const {
    roleFamily,
    experienceBucket,
    industryTag,
    predictedScore,
    actualOutcome,
  } = input;

  const sanitizedKey = validateWeightKey({
    roleFamily,
    experienceBucket,
    industryTag,
  });

  if (!isValidNumber(predictedScore) || predictedScore < 0 || predictedScore > 100) {
    errors.push('predictedScore must be a number between 0 and 100.');
  }

  if (actualOutcome !== OUTCOME.HIRE && actualOutcome !== OUTCOME.REJECT) {
    errors.push(
      `actualOutcome must be ${OUTCOME.HIRE} (hire) or ${OUTCOME.REJECT} (reject).`
    );
  }

  if (errors.length > 0) throwValidation(errors);

  return {
    ...sanitizedKey,
    predictedScore,
    actualOutcome,
  };
}

// ─────────────────────────────────────────────────────────────
// 🛠️ Validate Manual Override
// ─────────────────────────────────────────────────────────────

function validateManualOverride(input) {
  const errors = [];

  const { weights } = input;

  const sanitizedKey = validateWeightKey(input);

  const requiredKeys = Object.keys(DEFAULT_WEIGHTS);

  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    errors.push('weights must be a plain object.');
  } else {
    // ❗ Ensure only allowed keys
    for (const key of Object.keys(weights)) {
      if (!requiredKeys.includes(key)) {
        errors.push(`Invalid weight key: ${key}`);
      }
    }

    // ❗ Ensure all required keys exist
    for (const key of requiredKeys) {
      if (!(key in weights)) {
        errors.push(`Missing required weight key: ${key}`);
      }
    }

    // ❗ Validate values
    for (const [key, value] of Object.entries(weights)) {
      if (!isValidNumber(value)) {
        errors.push(`weights.${key} must be a valid number.`);
      } else if (value < WEIGHT_BOUNDS.min || value > WEIGHT_BOUNDS.max) {
        errors.push(
          `weights.${key} (${value}) violates bounds [${WEIGHT_BOUNDS.min}, ${WEIGHT_BOUNDS.max}].`
        );
      }
    }
  }

  if (errors.length > 0) throwValidation(errors);

  return {
    ...sanitizedKey,
    weights,
  };
}

// ─────────────────────────────────────────────────────────────
// 📦 EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  validateWeightKey,
  validateOutcomePayload,
  validateManualOverride,
};
