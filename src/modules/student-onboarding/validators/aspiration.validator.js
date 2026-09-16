'use strict';

/**
 * src/modules/student-onboarding/validators/aspiration.validator.js
 *
 * SERVER-SIDE VALIDATION — Aspiration Persistence (Phase 2)
 *
 * POSITION IN STACK:
 *   Route → [validateAspirationMiddleware] → Controller → Service
 *
 * VALIDATION PHILOSOPHY (matching cognitive.validator.js):
 *   • Server is authoritative. Frontend validation is UX-only.
 *   • Allowed values are read from constants/aspiration.js — the same
 *     module the repository/service use — never duplicated inline here.
 *   • careerInterests is required and non-empty; motivationDriver and
 *     timeHorizon are optional (the frontend submits them as null when
 *     unselected — see aspiration-step.tsx handleSubmit).
 *   • 'undecided' is mutually exclusive with every other career interest
 *     (mirrors aspiration-step.tsx's toggleDomain() behavior); a payload
 *     that violates this is rejected rather than silently coerced, since
 *     silently dropping values would mean the persisted record doesn't
 *     match what the student actually submitted.
 *
 * ERROR SHAPE:
 *   All errors throw AspirationValidationError({ message, field, status: 400 })
 */

const {
  CAREER_DOMAINS,
  MOTIVATION_DRIVERS,
  TIME_HORIZONS,
  MAX_CAREER_INTERESTS,
} = require('../constants/aspiration');

// ─────────────────────────────────────────────────────────────────────────────
// Validation error
// ─────────────────────────────────────────────────────────────────────────────

class AspirationValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name   = 'AspirationValidationError';
    this.field  = field;
    this.status = 400;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive validators
// ─────────────────────────────────────────────────────────────────────────────

function requireBody(body) {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    throw new AspirationValidationError('Request body must be a JSON object.');
  }
}

/**
 * Validates careerInterests: required, array, non-empty, every element a
 * known CAREER_DOMAINS value, no duplicates, no unexpected values, and
 * 'undecided' cannot be combined with any other domain.
 */
function validateCareerInterests(value) {
  if (!Array.isArray(value)) {
    throw new AspirationValidationError(
      'careerInterests is required and must be an array.',
      'careerInterests',
    );
  }

  if (value.length === 0) {
    throw new AspirationValidationError(
      'careerInterests must contain at least one selection.',
      'careerInterests',
    );
  }

  if (value.length > MAX_CAREER_INTERESTS) {
    throw new AspirationValidationError(
      `careerInterests cannot contain more than ${MAX_CAREER_INTERESTS} selections.`,
      'careerInterests',
    );
  }

  const seen = new Set();
  for (const domain of value) {
    if (typeof domain !== 'string' || !CAREER_DOMAINS.includes(domain)) {
      throw new AspirationValidationError(
        `careerInterests contains an invalid value: ${JSON.stringify(domain)}.`,
        'careerInterests',
      );
    }
    if (seen.has(domain)) {
      throw new AspirationValidationError(
        `careerInterests contains a duplicate value: ${JSON.stringify(domain)}.`,
        'careerInterests',
      );
    }
    seen.add(domain);
  }

  if (seen.has('undecided') && seen.size > 1) {
    throw new AspirationValidationError(
      "careerInterests cannot combine 'undecided' with other selections.",
      'careerInterests',
    );
  }

  // Return a canonical, deduplicated copy — never trust array identity/order
  // from the client beyond what was validated above.
  return [...seen];
}

/**
 * Validates an optional single-enum field (motivationDriver / timeHorizon).
 * Accepts null/undefined (optional); rejects any other non-matching value.
 */
function validateOptionalEnum(value, field, allowedValues) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    throw new AspirationValidationError(
      `${field} must be one of: ${allowedValues.join(', ')}, or null.`,
      field,
    );
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateSaveAspiration
// Validates the full aspiration save payload.
//
// Expected body shape:
//   {
//     careerInterests:  string[]      (1–MAX_CAREER_INTERESTS elements, required)
//     motivationDriver: string | null (optional)
//     timeHorizon:      string | null (optional)
//   }
//
// Returns a normalized, canonical payload — never passes the raw body
// through to the repository layer.
// ─────────────────────────────────────────────────────────────────────────────

function validateSaveAspiration(body) {
  requireBody(body);

  const careerInterests  = validateCareerInterests(body.careerInterests);
  const motivationDriver = validateOptionalEnum(
    body.motivationDriver, 'motivationDriver', MOTIVATION_DRIVERS,
  );
  const timeHorizon = validateOptionalEnum(
    body.timeHorizon, 'timeHorizon', TIME_HORIZONS,
  );

  return { careerInterests, motivationDriver, timeHorizon };
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware factory
// ─────────────────────────────────────────────────────────────────────────────

function validateSaveAspirationMiddleware(req, res, next) {
  try {
    req.validatedAspiration = validateSaveAspiration(req.body);
    next();
  } catch (err) {
    if (err.name === 'AspirationValidationError') {
      return res.status(400).json({
        ok:    false,
        error: { message: err.message, field: err.field },
      });
    }
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  AspirationValidationError,
  validateSaveAspiration,
  validateCareerInterests,
  validateOptionalEnum,
  validateSaveAspirationMiddleware,
};
