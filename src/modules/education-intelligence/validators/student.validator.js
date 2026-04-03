'use strict';

/**
 * src/modules/education-intelligence/validators/student.validator.js
 *
 * Input validation for Education Intelligence student endpoints.
 *
 * Pure validation functions.
 * Throws EducationValidationError on failure.
 */

const {
  EDUCATION_LEVELS,
  CLASS_LEVELS,
  ACTIVITY_LEVELS,
} = require('../models/student.model');

const { SUBJECTS } = require('../models/academic.model');

const SUBJECT_SET = new Set(SUBJECTS);

// ─────────────────────────────────────────────────────────────────────────────
// Student profile
// ─────────────────────────────────────────────────────────────────────────────

function validateCreateStudent({ name, email, education_level } = {}) {
  const errors = [];

  if (!isNonEmptyString(name)) {
    errors.push('name must be a non-empty string.');
  } else if (name.trim().length > 100) {
    errors.push('name must be under 100 characters.');
  }

  if (!isNonEmptyString(email)) {
    errors.push('email is required.');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    errors.push('email must be a valid email address.');
  }

  if (!education_level) {
    errors.push('education_level is required.');
  } else if (!EDUCATION_LEVELS.includes(education_level)) {
    errors.push(
      `education_level must be one of: ${EDUCATION_LEVELS.join(', ')}.`
    );
  }

  if (errors.length) throwValidationError(errors);
}

// ─────────────────────────────────────────────────────────────────────────────
// Academics
// ─────────────────────────────────────────────────────────────────────────────

function validateSaveAcademics({ records } = {}) {
  const errors = [];

  if (!Array.isArray(records) || records.length === 0) {
    errors.push('records must be a non-empty array.');
    throwValidationError(errors);
  }

  const seenSubjects = new Set();

  records.forEach((record, index) => {
    if (!record || typeof record !== 'object') {
      errors.push(`records[${index}] must be an object.`);
      return;
    }

    if (!record.subject || !SUBJECT_SET.has(record.subject)) {
      errors.push(
        `records[${index}].subject must be a valid subject name.`
      );
    } else if (seenSubjects.has(record.subject)) {
      errors.push(
        `records[${index}].subject contains duplicate subject "${record.subject}".`
      );
    } else {
      seenSubjects.add(record.subject);
    }

    if (
      !record.class_level ||
      !CLASS_LEVELS.includes(record.class_level)
    ) {
      errors.push(
        `records[${index}].class_level must be one of: ${CLASS_LEVELS.join(', ')}.`
      );
    }

    validateScoreField(
      record.marks,
      `records[${index}].marks`,
      errors
    );
  });

  if (errors.length) throwValidationError(errors);
}

// ─────────────────────────────────────────────────────────────────────────────
// Activities
// ─────────────────────────────────────────────────────────────────────────────

function validateSaveActivities({ activities } = {}) {
  const errors = [];

  if (!Array.isArray(activities) || activities.length === 0) {
    errors.push('activities must be a non-empty array.');
    throwValidationError(errors);
  }

  activities.forEach((activity, index) => {
    if (!activity || typeof activity !== 'object') {
      errors.push(`activities[${index}] must be an object.`);
      return;
    }

    if (!isNonEmptyString(activity.activity_name)) {
      errors.push(
        `activities[${index}].activity_name must be a non-empty string.`
      );
    } else if (activity.activity_name.trim().length > 100) {
      errors.push(
        `activities[${index}].activity_name must be under 100 characters.`
      );
    }

    if (
      !activity.activity_level ||
      !ACTIVITY_LEVELS.includes(activity.activity_level)
    ) {
      errors.push(
        `activities[${index}].activity_level must be one of: ${ACTIVITY_LEVELS.join(', ')}.`
      );
    }
  });

  if (errors.length) throwValidationError(errors);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive
// ─────────────────────────────────────────────────────────────────────────────

function validateSaveCognitive(fields = {}) {
  const errors = [];

  const scoreFields = [
    'analytical_score',
    'logical_score',
    'memory_score',
    'communication_score',
    'creativity_score',
  ];

  scoreFields.forEach((key) => {
    validateScoreField(fields[key], key, errors);
  });

  if (
    fields.raw_answers != null &&
    !isPlainObject(fields.raw_answers)
  ) {
    errors.push('raw_answers must be a plain object if provided.');
  }

  if (errors.length) throwValidationError(errors);
}

// ─────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────

function validateStudentId(id) {
  const errors = [];

  if (!isNonEmptyString(id)) {
    errors.push('Student id param must be a non-empty string.');
  }

  if (errors.length) throwValidationError(errors);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function validateScoreField(value, label, errors) {
  const parsed = Number(value);

  if (
    value == null ||
    Number.isNaN(parsed) ||
    parsed < 0 ||
    parsed > 100
  ) {
    errors.push(`${label} must be a number between 0 and 100.`);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function throwValidationError(errors) {
  const error = new Error(errors.join(' | '));
  error.name = 'EducationValidationError';
  error.statusCode = 422;
  error.details = errors;
  throw error;
}

module.exports = {
  validateCreateStudent,
  validateSaveAcademics,
  validateSaveActivities,
  validateSaveCognitive,
  validateStudentId,
};