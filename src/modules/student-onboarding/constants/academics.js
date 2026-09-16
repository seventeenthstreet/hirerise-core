'use strict';

/**
 * core/src/modules/student-onboarding/constants/academics.js
 *
 * Single source of truth for all academic-domain enum values.
 *
 * SYNC CONTRACT:
 *   Every value here must match:
 *     1. The SQL ENUM types in 20260522000001_student_academic_records.sql
 *     2. The frontend AcademicYear / AcademicSubject types in academic.types.ts
 *   If you add a value here → add it to the SQL migration AND the frontend types.
 *   Never diverge silently — the DB will reject unknown enum values at INSERT time.
 *
 * SIGNAL QUALITY THRESHOLDS:
 *   These constants drive evaluateAcademicSignalQuality() and must remain
 *   here (not inlined in the service) so future confidence engines can
 *   import them as tunable parameters.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC YEARS
// Mirror of: academic_year_enum in SQL
// ─────────────────────────────────────────────────────────────────────────────

/** @type {readonly string[]} */
const ACADEMIC_YEARS = Object.freeze([
  'class_8',
  'class_9',
  'class_10',
  'class_11',
  'class_12',
]);

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC SUBJECTS
// Mirror of: academic_subject_enum in SQL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * G5 (Phase 1): 'science' added as a single combined-Science subject for
 * Classes 8–10 (NCERT pre-stream curriculum). 'physics' / 'chemistry' /
 * 'biology' remain in this list because Classes 11–12 still expose them
 * as separate stream subjects (unchanged) and because pre-existing
 * Class 8–10 rows already saved under the old three-way model must
 * remain readable/valid. Only the frontend's SUBJECTS_BY_YEAR picker for
 * Classes 8–10 (academic.types.ts) has been changed to stop *offering*
 * physics/chemistry/biology as separate choices at that level — this
 * validator enum intentionally still accepts them so existing rows don't
 * fail validation on read/re-save.
 *
 * @type {readonly string[]}
 */
const ACADEMIC_SUBJECTS = Object.freeze([
  'mathematics',
  'science',
  'physics',
  'chemistry',
  'biology',
  'computer_science',
  'english',
  'social_science',
  'economics',
  'commerce',
  'accountancy',
  'business_studies',
  'history',
  'geography',
  'political_science',
  'language_optional',
]);

// ─────────────────────────────────────────────────────────────────────────────
// BOARD TYPES
// Mirror of: academic_board_type_enum in SQL
// ─────────────────────────────────────────────────────────────────────────────

/** @type {readonly string[]} */
const ACADEMIC_BOARD_TYPES = Object.freeze([
  'cbse',
  'icse',
  'state',
  'ib',
  'other',
]);

// ─────────────────────────────────────────────────────────────────────────────
// GRADE VALUES
// Mirror of: academic_grade_enum in SQL
// ─────────────────────────────────────────────────────────────────────────────

/** @type {readonly string[]} */
const ACADEMIC_GRADES = Object.freeze([
  'A_plus',
  'A',
  'B_plus',
  'B',
  'C',
  'D',
  'F',
]);

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE TYPES
// Mirror of: academic_source_type_enum in SQL
// ─────────────────────────────────────────────────────────────────────────────

/** @type {readonly string[]} */
const ACADEMIC_SOURCE_TYPES = Object.freeze([
  'manual',
  'ocr',
  'imported',
]);

// ─────────────────────────────────────────────────────────────────────────────
// MARKS CONSTRAINTS
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum allowed value for marks_obtained. */
const MIN_MARKS = 0;

/** Maximum allowed value for max_marks (sanity cap). */
const MAX_MARKS_CAP = 1000;

/** Minimum allowed value for max_marks. */
const MIN_MAX_MARKS = 1;

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL QUALITY THRESHOLDS
// Used by evaluateAcademicSignalQuality() — keep tunable here.
//
// RULE: Academics data is "sufficient" for progression WHEN EITHER:
//   Option A: ≥1 year has ≥ SUBJECTS_FOR_COMPLETE_YEAR subjects
//   Option B: ≥ YEARS_FOR_PARTIAL_SUFFICIENCY years each have ≥1 subject
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum subjects in a single year to call that year "complete". */
const SUBJECTS_FOR_COMPLETE_YEAR = 4;

/** Minimum number of years needed if no single year meets SUBJECTS_FOR_COMPLETE_YEAR. */
const YEARS_FOR_PARTIAL_SUFFICIENCY = 2;

/** Minimum subjects per year for partial-year counting. */
const MIN_SUBJECTS_FOR_PARTIAL_YEAR = 1;

// ─────────────────────────────────────────────────────────────────────────────
// GRADE → PERCENTAGE BANDS
// Used by normalization helpers to infer percentage from grade when marks absent.
// Mid-point of each band is used for normalization.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, { min: number, max: number, midpoint: number }>} */
const GRADE_PERCENTAGE_BANDS = Object.freeze({
  A_plus: { min: 90, max: 100, midpoint: 95 },
  A:      { min: 80, max: 89,  midpoint: 84 },
  B_plus: { min: 70, max: 79,  midpoint: 74 },
  B:      { min: 60, max: 69,  midpoint: 64 },
  C:      { min: 50, max: 59,  midpoint: 54 },
  D:      { min: 40, max: 49,  midpoint: 44 },
  F:      { min: 0,  max: 39,  midpoint: 20 },
});

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL DERIVATION — EVIDENCE STRENGTH TUNABLES
// Phase 3B.2 — Student-Native Academic Signal Derivation
//
// PREDICTED_EVIDENCE_DISCOUNT:
//   No existing project convention was found for weighting predicted vs.
//   completed academic results differently (searched academic-normalization.js,
//   academic-signal-quality.js, and the intelligence signal layer). Predicted
//   marks/grades are self-reported ahead of official declaration and carry
//   more uncertainty than a completed, declared result.
//
//   This is the smallest defensible deterministic treatment: a flat multiplier
//   applied to a signal contribution's weight when either the subject row
//   (student_academic_subjects.is_predicted) or its parent year record
//   (student_academic_records.is_predicted) is true. It does not attempt a
//   statistical adjustment — it is a fixed, documented discount, applied
//   identically regardless of subject or magnitude.
// ─────────────────────────────────────────────────────────────────────────────

/** Multiplier applied to signal contribution weight for predicted (undeclared) results. */
const PREDICTED_EVIDENCE_DISCOUNT = 0.85;

module.exports = {
  ACADEMIC_YEARS,
  ACADEMIC_SUBJECTS,
  ACADEMIC_BOARD_TYPES,
  ACADEMIC_GRADES,
  ACADEMIC_SOURCE_TYPES,
  MIN_MARKS,
  MAX_MARKS_CAP,
  MIN_MAX_MARKS,
  SUBJECTS_FOR_COMPLETE_YEAR,
  YEARS_FOR_PARTIAL_SUFFICIENCY,
  MIN_SUBJECTS_FOR_PARTIAL_YEAR,
  GRADE_PERCENTAGE_BANDS,
  PREDICTED_EVIDENCE_DISCOUNT,
};
