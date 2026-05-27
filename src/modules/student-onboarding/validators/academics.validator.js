'use strict';

/**
 * core/src/modules/student-onboarding/validators/academics.validator.js
 *
 * Server-side validation for the academics step payload.
 *
 * POSITION IN STACK:
 *   Route → [validateAcademicsPayload middleware] → Controller → Service
 *
 * VALIDATION PHILOSOPHY:
 *   • This is the authoritative gate. Frontend validation is UX-only.
 *   • Partial saves are explicitly supported — not all subjects need marks.
 *   • Duplicate subjects within the same year are rejected.
 *   • marks_obtained > max_marks is rejected.
 *   • Malformed payloads never reach the service layer.
 *
 * ERROR SHAPE:
 *   All errors throw OnboardingValidationError({ message, field, status: 400 })
 *   The global error handler serializes this to:
 *     { ok: false, error: { code, message, field } }
 */

const {
  ACADEMIC_YEARS,
  ACADEMIC_SUBJECTS,
  ACADEMIC_BOARD_TYPES,
  ACADEMIC_GRADES,
  ACADEMIC_SOURCE_TYPES,
  MIN_MARKS,
  MAX_MARKS_CAP,
  MIN_MAX_MARKS,
} = require('../constants/academics');

// ─────────────────────────────────────────────────────────────────────────────
// Validation error
// ─────────────────────────────────────────────────────────────────────────────

class OnboardingValidationError extends Error {
  /**
   * @param {string}      message
   * @param {string|null} field
   */
  constructor(message, field = null) {
    super(message);
    this.name   = 'OnboardingValidationError';
    this.field  = field;
    this.status = 400;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive validators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} body
 * @throws {OnboardingValidationError}
 */
function requireBody(body) {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    throw new OnboardingValidationError('Request body must be a JSON object.');
  }
}

/**
 * @param {unknown}  value
 * @param {string[]} allowed
 * @param {string}   fieldName
 * @throws {OnboardingValidationError}
 */
function requireEnum(value, allowed, fieldName) {
  if (value === undefined || value === null) {
    throw new OnboardingValidationError(`${fieldName} is required.`, fieldName);
  }
  if (!allowed.includes(value)) {
    throw new OnboardingValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}.`,
      fieldName,
    );
  }
}

/**
 * Validates an optional numeric field within a range.
 * @param {unknown} value
 * @param {number}  min
 * @param {number}  max
 * @param {string}  fieldName
 * @throws {OnboardingValidationError}
 */
function optionalNumericRange(value, min, max, fieldName) {
  if (value === null || value === undefined) return; // optional — allowed
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new OnboardingValidationError(`${fieldName} must be a number.`, fieldName);
  }
  if (n < min || n > max) {
    throw new OnboardingValidationError(
      `${fieldName} must be between ${min} and ${max}.`,
      fieldName,
    );
  }
}

/**
 * Validates an optional enum field.
 * @param {unknown}  value
 * @param {string[]} allowed
 * @param {string}   fieldName
 * @throws {OnboardingValidationError}
 */
function optionalEnum(value, allowed, fieldName) {
  if (value === null || value === undefined) return;
  if (!allowed.includes(value)) {
    throw new OnboardingValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}.`,
      fieldName,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject-level validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a single subject entry within an academic year.
 *
 * @param {unknown} subject
 * @param {number}  index     Position in the subjects array (for field path in errors)
 * @param {string}  yearKey   Academic year key (for field path in errors)
 * @throws {OnboardingValidationError}
 */
function validateSubjectEntry(subject, index, yearKey) {
  const field = (f) => `years.${yearKey}.subjects[${index}].${f}`;

  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) {
    throw new OnboardingValidationError(
      `Subject entry at index ${index} must be an object.`,
      `years.${yearKey}.subjects[${index}]`,
    );
  }

  // subject name — required
  requireEnum(subject.subject, ACADEMIC_SUBJECTS, field('subject'));

  // marks_obtained — optional, but must be valid if present
  optionalNumericRange(subject.marks_obtained, MIN_MARKS, MAX_MARKS_CAP, field('marks_obtained'));

  // max_marks — optional, but must be valid if present
  if (subject.max_marks !== null && subject.max_marks !== undefined) {
    optionalNumericRange(subject.max_marks, MIN_MAX_MARKS, MAX_MARKS_CAP, field('max_marks'));
  }

  // marks_obtained must not exceed max_marks
  if (
    subject.marks_obtained !== null && subject.marks_obtained !== undefined &&
    subject.max_marks      !== null && subject.max_marks      !== undefined
  ) {
    const obtained = Number(subject.marks_obtained);
    const max      = Number(subject.max_marks);
    if (obtained > max) {
      throw new OnboardingValidationError(
        'marks_obtained cannot exceed max_marks.',
        field('marks_obtained'),
      );
    }
  }

  // grade — optional
  optionalEnum(subject.grade, ACADEMIC_GRADES, field('grade'));

  // source_type — optional, defaults to 'manual' in the service
  optionalEnum(subject.source_type, ACADEMIC_SOURCE_TYPES, field('source_type'));

  // is_predicted — optional boolean
  if (subject.is_predicted !== null && subject.is_predicted !== undefined) {
    if (typeof subject.is_predicted !== 'boolean') {
      throw new OnboardingValidationError(
        'is_predicted must be a boolean.',
        field('is_predicted'),
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Year-level validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a single academic year payload.
 *
 * @param {unknown} yearPayload
 * @param {string}  yearKey
 * @throws {OnboardingValidationError}
 */
function validateAcademicYear(yearPayload, yearKey) {
  if (yearPayload === null || typeof yearPayload !== 'object' || Array.isArray(yearPayload)) {
    throw new OnboardingValidationError(
      `Academic year '${yearKey}' must be an object.`,
      `years.${yearKey}`,
    );
  }

  // board_type — required per year
  requireEnum(yearPayload.board_type, ACADEMIC_BOARD_TYPES, `years.${yearKey}.board_type`);

  // is_predicted — optional boolean
  if (yearPayload.is_predicted !== null && yearPayload.is_predicted !== undefined) {
    if (typeof yearPayload.is_predicted !== 'boolean') {
      throw new OnboardingValidationError(
        'is_predicted must be a boolean.',
        `years.${yearKey}.is_predicted`,
      );
    }
  }

  // subjects — must be an array (can be empty for partial saves)
  if (!Array.isArray(yearPayload.subjects)) {
    throw new OnboardingValidationError(
      `years.${yearKey}.subjects must be an array.`,
      `years.${yearKey}.subjects`,
    );
  }

  // Validate each subject entry
  const seenSubjects = new Set();
  for (let i = 0; i < yearPayload.subjects.length; i++) {
    validateSubjectEntry(yearPayload.subjects[i], i, yearKey);

    // Duplicate subject check
    const subjectName = yearPayload.subjects[i]?.subject;
    if (subjectName) {
      if (seenSubjects.has(subjectName)) {
        throw new OnboardingValidationError(
          `Duplicate subject '${subjectName}' in year '${yearKey}'.`,
          `years.${yearKey}.subjects[${i}].subject`,
        );
      }
      seenSubjects.add(subjectName);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level payload validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the full POST /academics payload.
 *
 * Expected shape:
 * {
 *   years: {
 *     class_10: {
 *       board_type: 'cbse',
 *       is_predicted: false,
 *       subjects: [
 *         { subject: 'mathematics', marks_obtained: 88, max_marks: 100, grade: 'A' },
 *         ...
 *       ]
 *     },
 *     ...
 *   },
 *   is_partial: boolean   // true = draft save, false = commit & advance
 * }
 *
 * @param {unknown} body
 * @throws {OnboardingValidationError}
 */
function validateAcademicsPayload(body) {
  requireBody(body);

  // years — required, must be a non-null object
  if (body.years === null || body.years === undefined) {
    throw new OnboardingValidationError('years is required.', 'years');
  }
  if (typeof body.years !== 'object' || Array.isArray(body.years)) {
    throw new OnboardingValidationError('years must be an object.', 'years');
  }

  const yearKeys = Object.keys(body.years);

  // At least one year must be present
  if (yearKeys.length === 0) {
    throw new OnboardingValidationError(
      'At least one academic year must be provided.',
      'years',
    );
  }

  // Validate each year key
  for (const yearKey of yearKeys) {
    if (!ACADEMIC_YEARS.includes(yearKey)) {
      throw new OnboardingValidationError(
        `'${yearKey}' is not a valid academic year. Must be one of: ${ACADEMIC_YEARS.join(', ')}.`,
        `years.${yearKey}`,
      );
    }
    validateAcademicYear(body.years[yearKey], yearKey);
  }

  // is_partial — required boolean
  if (body.is_partial === null || body.is_partial === undefined) {
    throw new OnboardingValidationError('is_partial is required.', 'is_partial');
  }
  if (typeof body.is_partial !== 'boolean') {
    throw new OnboardingValidationError('is_partial must be a boolean.', 'is_partial');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express middleware. Validates the academics POST body.
 * Passes on success; calls next(err) with a 400 error on failure.
 *
 * @type {import('express').RequestHandler}
 */
function validateAcademicsMiddleware(req, res, next) {
  try {
    validateAcademicsPayload(req.body);
    next();
  } catch (err) {
    if (err.name === 'OnboardingValidationError') {
      return res.status(400).json({
        ok:    false,
        error: {
          code:    'VALIDATION_ERROR',
          message: err.message,
          field:   err.field ?? null,
        },
      });
    }
    next(err);
  }
}

module.exports = {
  validateAcademicsPayload,
  validateAcademicsMiddleware,
  OnboardingValidationError,
  // Export primitive validators for reuse in other validators
  requireEnum,
  optionalEnum,
  optionalNumericRange,
};
