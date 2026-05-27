'use strict';

/**
 * src/modules/student-onboarding/validators/studentOnboarding.validator.js
 *
 * Server-side validation for all student onboarding step payloads.
 * Frontend validation is UX-only — this layer is the authoritative gate.
 *
 * Pattern:
 *  - validateStep(stepName) returns an Express middleware.
 *  - Each step has its own schema function.
 *  - New step validators are added to STEP_VALIDATORS and nowhere else.
 *  - Unknown steps pass through (supports phased route registration).
 */

const {
  EDUCATION_LEVELS,
  BOARD_TYPES,
  SCHOOL_TYPES,
} = require('../constants');

// ─────────────────────────────────────────────────────────────────────────────
// Validation error — structured, never exposes Supabase internals
// ─────────────────────────────────────────────────────────────────────────────

class OnboardingValidationError extends Error {
  /**
   * @param {string}      message  Human-readable description
   * @param {string|null} field    The offending field name, if applicable
   */
  constructor(message, field = null) {
    super(message);
    this.name   = 'OnboardingValidationError';
    this.field  = field;
    this.status = 400;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive validators — reusable building blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asserts that req.body is a non-null, non-array object.
 *
 * @param {unknown} body
 * @throws {OnboardingValidationError}
 */
function requireBody(body) {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    throw new OnboardingValidationError(
      'Request body is required and must be a JSON object.',
    );
  }
}

/**
 * Asserts a required field is present and is one of the allowed values.
 *
 * @param {unknown}  value
 * @param {string[]} allowed
 * @param {string}   fieldName
 * @throws {OnboardingValidationError}
 */
function requireEnum(value, allowed, fieldName) {
  if (value === undefined || value === null || value === '') {
    throw new OnboardingValidationError(
      `${fieldName} is required.`,
      fieldName,
    );
  }
  if (!allowed.includes(value)) {
    throw new OnboardingValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}.`,
      fieldName,
    );
  }
}

/**
 * Asserts an optional field, when present, is one of the allowed values.
 * Undefined and null are silently accepted.
 *
 * @param {unknown}  value
 * @param {string[]} allowed
 * @param {string}   fieldName
 * @throws {OnboardingValidationError}
 */
function optionalEnum(value, allowed, fieldName) {
  if (value === undefined || value === null) return;
  if (!allowed.includes(value)) {
    throw new OnboardingValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}.`,
      fieldName,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates POST /step/education payload.
 *
 * Required: education_level
 * Optional: board_type, school_type
 *
 * @param {object} body
 * @throws {OnboardingValidationError}
 */
function validateEducationStep(body) {
  requireBody(body);
  requireEnum(body.education_level, EDUCATION_LEVELS, 'education_level');
  optionalEnum(body.board_type,     BOARD_TYPES,      'board_type');
  optionalEnum(body.school_type,    SCHOOL_TYPES,     'school_type');
}

// ─────────────────────────────────────────────────────────────────────────────
// Step validator registry
// Add new step schemas here as phases are implemented.
// ─────────────────────────────────────────────────────────────────────────────

const STEP_VALIDATORS = {
  education: validateEducationStep,
  // academics:  validateAcademicsStep,   — Phase 2
  // activities: validateActivitiesStep,  — Phase 2
  // cognitive:  validateCognitiveStep,   — Phase 2
  // aspiration: validateAspirationStep,  — Phase 2
};

// ─────────────────────────────────────────────────────────────────────────────
// Middleware factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that validates the request body for the
 * named onboarding step. If no validator is registered for the step, the
 * middleware is a no-op — this allows routes for future phases to be
 * registered without failing.
 *
 * On validation failure: responds 400 with { ok, error, field }.
 * On unexpected error:   calls next(err) to reach the global error handler.
 *
 * @param {string} step
 * @returns {import('express').RequestHandler}
 */
function validateStep(step) {
  const validator = STEP_VALIDATORS[step];

  if (!validator) {
    // No validator registered yet — pass through
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    try {
      validator(req.body);
      next();
    } catch (err) {
      if (err instanceof OnboardingValidationError) {
        return res.status(400).json({
          ok:    false,
          error: err.message,
          field: err.field ?? null,
        });
      }
      // Unexpected error — let global error handler deal with it
      next(err);
    }
  };
}

module.exports = {
  validateStep,
  validateEducationStep,
  OnboardingValidationError,
};
