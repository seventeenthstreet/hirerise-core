'use strict';

/**
 * validators/student.validator.js
 *
 * Input validation for all Education Intelligence endpoints.
 *
 * Pattern: matches the existing codebase's adaptiveWeight.validator.js style —
 * pure validation functions that throw a structured error on failure.
 * No express-validator dependency — plain JS validation, consistent with
 * the simpler modules in this project.
 *
 * Each function returns void on success or throws a ValidationError.
 */

const { EDUCATION_LEVELS, CLASS_LEVELS, ACTIVITY_LEVELS } = require('../models/student.model');
const { SUBJECTS } = require('../models/academic.model');

const SUBJECT_SET = new Set(SUBJECTS);

// ─── POST /api/education/student ─────────────────────────────────────────────

function validateCreateStudent({ name, email, education_level }) {
  const errors = [];

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    errors.push('name must be a non-empty string.');
  } else if (name.trim().length > 100) {
    errors.push('name must be under 100 characters.');
  }

  if (!email || typeof email !== 'string') {
    errors.push('email is required.');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    errors.push('email must be a valid email address.');
  }

  if (!education_level) {
    errors.push('education_level is required.');
  } else if (!EDUCATION_LEVELS.includes(education_level)) {
    errors.push(`education_level must be one of: ${EDUCATION_LEVELS.join(', ')}.`);
  }

  if (errors.length) _throw(errors);
}

// ─── POST /api/education/academics ───────────────────────────────────────────

function validateSaveAcademics({ records }) {
  const errors = [];

  if (!Array.isArray(records) || records.length === 0) {
    errors.push('records must be a non-empty array.');
    _throw(errors); // stop here — can't iterate
  }

  records.forEach((r, i) => {
    if (!r.subject || !SUBJECT_SET.has(r.subject)) {
      errors.push(`records[${i}].subject must be a valid subject name.`);
    }
    if (!r.class_level || !CLASS_LEVELS.includes(r.class_level)) {
      errors.push(`records[${i}].class_level must be one of: ${CLASS_LEVELS.join(', ')}.`);
    }
    const marks = Number(r.marks);
    if (r.marks == null || isNaN(marks) || marks < 0 || marks > 100) {
      errors.push(`records[${i}].marks must be a number between 0 and 100.`);
    }
  });

  if (errors.length) _throw(errors);
}

// ─── POST /api/education/activities ──────────────────────────────────────────

function validateSaveActivities({ activities }) {
  const errors = [];

  if (!Array.isArray(activities) || activities.length === 0) {
    errors.push('activities must be a non-empty array.');
    _throw(errors);
  }

  activities.forEach((a, i) => {
    if (!a.activity_name || typeof a.activity_name !== 'string' || a.activity_name.trim().length === 0) {
      errors.push(`activities[${i}].activity_name must be a non-empty string.`);
    } else if (a.activity_name.trim().length > 100) {
      errors.push(`activities[${i}].activity_name must be under 100 characters.`);
    }
    if (!a.activity_level || !ACTIVITY_LEVELS.includes(a.activity_level)) {
      errors.push(`activities[${i}].activity_level must be one of: ${ACTIVITY_LEVELS.join(', ')}.`);
    }
  });

  if (errors.length) _throw(errors);
}

// ─── POST /api/education/cognitive ───────────────────────────────────────────

function validateSaveCognitive(fields) {
  const errors = [];
  const scoreFields = [
    'analytical_score',
    'logical_score',
    'memory_score',
    'communication_score',
    'creativity_score',
  ];

  scoreFields.forEach(key => {
    const val = Number(fields[key]);
    if (fields[key] == null || isNaN(val) || val < 0 || val > 100) {
      errors.push(`${key} must be a number between 0 and 100.`);
    }
  });

  if (fields.raw_answers != null && (typeof fields.raw_answers !== 'object' || Array.isArray(fields.raw_answers))) {
    errors.push('raw_answers must be a plain object if provided.');
  }

  if (errors.length) _throw(errors);
}

// ─── GET /api/education/student/:id ──────────────────────────────────────────

function validateStudentId(id) {
  const errors = [];
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    errors.push('Student id param must be a non-empty string.');
  }
  if (errors.length) _throw(errors);
}

// ─── Private helper ───────────────────────────────────────────────────────────

function _throw(errors) {
  const err = new Error(errors.join(' | '));
  err.name       = 'EducationValidationError';
  err.statusCode = 422;
  err.details    = errors;
  throw err;
}

module.exports = {
  validateCreateStudent,
  validateSaveAcademics,
  validateSaveActivities,
  validateSaveCognitive,
  validateStudentId,
};









