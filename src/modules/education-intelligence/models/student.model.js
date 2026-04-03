'use strict';

/**
 * src/modules/education/models/student.model.js
 *
 * Supabase row schema helpers for the Education Intelligence module.
 *
 * PURPOSE
 * - Central source of truth for table names
 * - Row factory helpers for inserts / upserts
 * - Enum constants shared across validators and services
 * - No Firestore/Firebase assumptions
 *
 * NOTES
 * - Timestamps are SQL-managed via DEFAULT now() / triggers
 * - Primary keys and generated IDs are DB-managed
 * - Builders return clean row payloads only
 */

/**
 * Deep freeze utility for immutable shared config.
 *
 * @param {object | Array<any>} value
 * @returns {object | Array<any>}
 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }

  return value;
}

/**
 * Safe numeric conversion.
 *
 * @param {unknown} value
 * @param {number | null} fallback
 * @returns {number | null}
 */
function toNumberOr(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table names
// ─────────────────────────────────────────────────────────────────────────────

const TABLES = deepFreeze({
  STUDENTS: 'edu_students',
  ACADEMIC_RECORDS: 'edu_academic_records',
  EXTRACURRICULAR: 'edu_extracurricular',
  COGNITIVE_RESULTS: 'edu_cognitive_results',
  STREAM_SCORES: 'edu_stream_scores',
  CAREER_PREDICTIONS: 'lmi_career_predictions',
  EDUCATION_ROI: 'edu_education_roi',
  CAREER_SIMULATIONS: 'edu_career_simulations',
});

// Backward compatibility export alias
const COLLECTIONS = TABLES;

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

const EDUCATION_LEVELS = deepFreeze([
  'class_8',
  'class_9',
  'class_10',
  'class_11',
  'class_12',
  'undergraduate',
  'postgraduate',
]);

const CLASS_LEVELS = deepFreeze([
  'class_8',
  'class_9',
  'class_10',
  'class_11',
  'class_12',
]);

const ACTIVITY_LEVELS = deepFreeze([
  'beginner',
  'intermediate',
  'advanced',
  'national',
  'international',
]);

const ONBOARDING_STEPS = deepFreeze([
  'profile',
  'academics',
  'activities',
  'cognitive',
  'complete',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Row builders
// ─────────────────────────────────────────────────────────────────────────────

function buildStudentRow(userId, fields = {}) {
  return {
    id: userId,
    name: fields.name ?? null,
    email: fields.email ?? null,
    education_level: fields.education_level ?? null,
    onboarding_step: fields.onboarding_step ?? 'profile',
  };
}

function buildAcademicRecordRow(studentId, fields = {}) {
  return {
    student_id: studentId,
    subject: fields.subject ?? null,
    class_level: fields.class_level ?? null,
    marks: toNumberOr(fields.marks),
  };
}

function buildActivityRow(studentId, fields = {}) {
  return {
    student_id: studentId,
    activity_name: fields.activity_name ?? null,
    activity_level: fields.activity_level ?? null,
  };
}

function buildCognitiveResultRow(studentId, fields = {}) {
  return {
    student_id: studentId,
    analytical_score: toNumberOr(fields.analytical_score, 0),
    logical_score: toNumberOr(fields.logical_score, 0),
    memory_score: toNumberOr(fields.memory_score, 0),
    communication_score: toNumberOr(fields.communication_score, 0),
    creativity_score: toNumberOr(fields.creativity_score, 0),
    raw_answers: fields.raw_answers ?? {},
  };
}

function buildStreamScoreRow(studentId) {
  return {
    student_id: studentId,
    engineering_score: null,
    medical_score: null,
    commerce_score: null,
    humanities_score: null,
    recommended_stream: null,
    confidence: null,
    engine_version: null,
    calculated_at: null,
  };
}

// Backward compatibility aliases
const buildStudentDoc = buildStudentRow;
const buildAcademicRecordDoc = buildAcademicRecordRow;
const buildActivityDoc = buildActivityRow;
const buildCognitiveDoc = buildCognitiveResultRow;
const buildStreamScoreDoc = buildStreamScoreRow;

module.exports = {
  TABLES,
  COLLECTIONS,

  EDUCATION_LEVELS,
  CLASS_LEVELS,
  ACTIVITY_LEVELS,
  ONBOARDING_STEPS,

  buildStudentRow,
  buildAcademicRecordRow,
  buildActivityRow,
  buildCognitiveResultRow,
  buildStreamScoreRow,

  // backward compatibility
  buildStudentDoc,
  buildAcademicRecordDoc,
  buildActivityDoc,
  buildCognitiveDoc,
  buildStreamScoreDoc,
};