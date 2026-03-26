'use strict';

/**
 * models/student.model.js
 *
 * Firestore collection names and document shape builders for the
 * Education Intelligence module.
 *
 * Collections (all prefixed edu_ to stay isolated from career platform):
 *   edu_students              — one doc per user, keyed by user ID
 *   edu_academic_records      — many docs per student
 *   edu_extracurricular       — many docs per student
 *   edu_cognitive_results     — one doc per student, keyed by user ID
 *   edu_stream_scores         — one doc per student, keyed by user ID
 *                               (written by Stream Intelligence Engine in Step 3)
 *
 * These collections are completely separate from the career platform's
 * users, userProfiles, chiSnapshots, etc. collections.
 */

// ─── Collection names — single source of truth ───────────────────────────────

const COLLECTIONS = {
  STUDENTS:             'edu_students',
  ACADEMIC:             'edu_academic_records',
  ACTIVITIES:           'edu_extracurricular',
  COGNITIVE:            'edu_cognitive_results',
  STREAM_SCORES:        'edu_stream_scores',
  CAREER_PREDICTIONS:   'edu_career_predictions',
  EDUCATION_ROI:        'edu_education_roi',
  CAREER_SIMULATIONS:   'edu_career_simulations',
};

// ─── Enums ────────────────────────────────────────────────────────────────────

const EDUCATION_LEVELS = [
  'class_8', 'class_9', 'class_10',
  'class_11', 'class_12',
  'undergraduate', 'postgraduate',
];

const CLASS_LEVELS = [
  'class_8', 'class_9', 'class_10', 'class_11', 'class_12',
];

const ACTIVITY_LEVELS = [
  'beginner', 'intermediate', 'advanced', 'national', 'international',
];

const ONBOARDING_STEPS = [
  'profile', 'academics', 'activities', 'cognitive', 'complete',
];

// ─── Document builders ────────────────────────────────────────────────────────
// These define the shape written to Firestore.
// Timestamps are always null here — the repository sets them via FieldValue.serverTimestamp().

/**
 * edu_students/{userId}
 *
 *   id              — user ID (doc ID, also stored as field for queries)
 *   name            — string
 *   email           — string
 *   education_level — EDUCATION_LEVELS value
 *   onboarding_step — ONBOARDING_STEPS value (tracks progress)
 *   created_at      — serverTimestamp
 *   updated_at      — serverTimestamp
 */
function buildStudentDoc(userId, fields) {
  return {
    id:              userId,
    name:            fields.name            || null,
    email:           fields.email           || null,
    education_level: fields.education_level || null,
    onboarding_step: 'profile',
    created_at:      null, // set by repository
    updated_at:      null, // set by repository
  };
}

/**
 * edu_academic_records/{autoId}
 *
 *   student_id  — user ID
 *   subject     — string
 *   class_level — CLASS_LEVELS value
 *   marks       — number 0–100
 *   created_at  — serverTimestamp
 */
function buildAcademicRecordDoc(studentId, fields) {
  return {
    student_id:  studentId,
    subject:     fields.subject     || null,
    class_level: fields.class_level || null,
    marks:       fields.marks       != null ? Number(fields.marks) : null,
    created_at:  null,
  };
}

/**
 * edu_extracurricular/{autoId}
 *
 *   student_id     — user ID
 *   activity_name  — string
 *   activity_level — ACTIVITY_LEVELS value
 *   created_at     — serverTimestamp
 */
function buildActivityDoc(studentId, fields) {
  return {
    student_id:     studentId,
    activity_name:  fields.activity_name  || null,
    activity_level: fields.activity_level || null,
    created_at:     null,
  };
}

/**
 * edu_cognitive_results/{userId}  (doc ID = userId — one per student)
 *
 *   student_id          — user ID
 *   analytical_score    — number 0–100
 *   logical_score       — number 0–100
 *   memory_score        — number 0–100
 *   communication_score — number 0–100
 *   creativity_score    — number 0–100
 *   raw_answers         — object (stored for future engine reprocessing)
 *   created_at          — serverTimestamp
 *   updated_at          — serverTimestamp
 */
function buildCognitiveDoc(studentId, fields) {
  return {
    student_id:          studentId,
    analytical_score:    Number(fields.analytical_score)    || 0,
    logical_score:       Number(fields.logical_score)       || 0,
    memory_score:        Number(fields.memory_score)        || 0,
    communication_score: Number(fields.communication_score) || 0,
    creativity_score:    Number(fields.creativity_score)    || 0,
    raw_answers:         fields.raw_answers || {},
    created_at:          null,
    updated_at:          null,
  };
}

/**
 * edu_stream_scores/{userId}  (doc ID = userId — one per student)
 *
 * Created empty when student profile is first made.
 * Populated by Stream Intelligence Engine in Step 3.
 *
 *   student_id          — user ID
 *   engineering_score   — null (filled by engine)
 *   medical_score       — null
 *   commerce_score      — null
 *   humanities_score    — null
 *   recommended_stream  — null
 *   confidence          — null (0–100)
 *   engine_version      — null
 *   calculated_at       — null
 */
function buildStreamScoreDoc(studentId) {
  return {
    student_id:         studentId,
    engineering_score:  null,
    medical_score:      null,
    commerce_score:     null,
    humanities_score:   null,
    recommended_stream: null,
    confidence:         null,
    engine_version:     null,
    calculated_at:      null,
  };
}

module.exports = {
  COLLECTIONS,
  EDUCATION_LEVELS,
  CLASS_LEVELS,
  ACTIVITY_LEVELS,
  ONBOARDING_STEPS,
  buildStudentDoc,
  buildAcademicRecordDoc,
  buildActivityDoc,
  buildCognitiveDoc,
  buildStreamScoreDoc,
};









