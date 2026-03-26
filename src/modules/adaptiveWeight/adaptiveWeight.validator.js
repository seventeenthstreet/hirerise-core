// adaptiveWeight.validator.js

const {
  VALID_EXPERIENCE_BUCKETS,
  WEIGHT_BOUNDS,
  OUTCOME,
} = require("./adaptiveWeight.constants");

/**
 * Validates the lookup key used to fetch or initialize an adaptive weight record.
 */
function validateWeightKey({ roleFamily, experienceBucket, industryTag }) {
  const errors = [];

  if (!roleFamily || typeof roleFamily !== "string" || roleFamily.trim().length === 0) {
    errors.push("roleFamily must be a non-empty string.");
  }

  if (!VALID_EXPERIENCE_BUCKETS.includes(experienceBucket)) {
    errors.push(`experienceBucket must be one of: ${VALID_EXPERIENCE_BUCKETS.join(", ")}.`);
  }

  if (!industryTag || typeof industryTag !== "string" || industryTag.trim().length === 0) {
    errors.push("industryTag must be a non-empty string.");
  }

  if (errors.length > 0) throwValidation(errors);
}

/**
 * Validates a hiring outcome payload before applying weight learning.
 */
function validateOutcomePayload({ roleFamily, experienceBucket, industryTag, predictedScore, actualOutcome }) {
  validateWeightKey({ roleFamily, experienceBucket, industryTag });

  const errors = [];

  if (typeof predictedScore !== "number" || predictedScore < 0 || predictedScore > 100) {
    errors.push("predictedScore must be a number between 0 and 100.");
  }

  if (actualOutcome !== OUTCOME.HIRE && actualOutcome !== OUTCOME.REJECT) {
    errors.push(`actualOutcome must be ${OUTCOME.HIRE} (hire) or ${OUTCOME.REJECT} (reject).`);
  }

  if (errors.length > 0) throwValidation(errors);
}

/**
 * Validates a manual weight override payload.
 * Weights are not normalized here — normalization happens in the service.
 * Validation only checks structural integrity and boundary compliance.
 */
function validateManualOverride({ roleFamily, experienceBucket, industryTag, weights }) {
  validateWeightKey({ roleFamily, experienceBucket, industryTag });

  const errors = [];

  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    errors.push("weights must be a plain object.");
  } else {
    for (const [key, value] of Object.entries(weights)) {
      if (typeof value !== "number" || isNaN(value)) {
        errors.push(`weights.${key} must be a valid number.`);
      } else if (value < WEIGHT_BOUNDS.min || value > WEIGHT_BOUNDS.max) {
        errors.push(`weights.${key} (${value}) violates bounds [${WEIGHT_BOUNDS.min}, ${WEIGHT_BOUNDS.max}].`);
      }
    }
  }

  if (errors.length > 0) throwValidation(errors);
}

function throwValidation(errors) {
  const err = new Error(errors.join(" | "));
  err.name = "AdaptiveWeightValidationError";
  err.statusCode = 422;
  err.details = errors;
  throw err;
}

module.exports = { validateWeightKey, validateOutcomePayload, validateManualOverride };








