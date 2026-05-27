'use strict';

/**
 * core/src/modules/student-onboarding/helpers/academic-normalization.js
 *
 * ACADEMIC NORMALIZATION HELPERS
 * ────────────────────────────────
 * Converts raw submitted academic data into normalized, analytics-ready form.
 *
 * SCOPE (Phase 3A):
 *   ✅ Percentage computation from marks
 *   ✅ Grade inference from percentage
 *   ✅ Percentage inference from grade (mid-band)
 *   ✅ Board normalization (lowercase + trim)
 *   ✅ Missing subject handling (null-safe)
 *
 * OUT OF SCOPE (do NOT implement):
 *   ❌ Scoring
 *   ❌ Stream affinity weighting
 *   ❌ Confidence calculation
 *   ❌ Velocity analysis
 *
 * These helpers are intentionally pure functions — no DB access, no side effects.
 * This makes them safe to import from intelligence engines in future phases.
 */

const { GRADE_PERCENTAGE_BANDS, ACADEMIC_GRADES } = require('../constants/academics');

// ─────────────────────────────────────────────────────────────────────────────
// PERCENTAGE COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes percentage from marks_obtained and max_marks.
 * Returns null when either value is missing or invalid.
 *
 * @param {number|null|undefined} marksObtained
 * @param {number|null|undefined} maxMarks
 * @returns {number|null}  Rounded to 2 decimal places, or null.
 */
function computePercentage(marksObtained, maxMarks) {
  if (marksObtained === null || marksObtained === undefined) return null;
  if (maxMarks === null || maxMarks === undefined || maxMarks <= 0) return null;

  const raw = (Number(marksObtained) / Number(maxMarks)) * 100;
  if (!Number.isFinite(raw)) return null;

  // Clamp to [0, 100] — defensive against floating point edge cases
  return Math.round(Math.min(100, Math.max(0, raw)) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// GRADE INFERENCE FROM PERCENTAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Infers the normalized letter grade from a percentage.
 * Returns null for invalid or null percentage.
 *
 * @param {number|null|undefined} percentage
 * @returns {string|null}  One of ACADEMIC_GRADES, or null.
 */
function inferGradeFromPercentage(percentage) {
  if (percentage === null || percentage === undefined) return null;
  const pct = Number(percentage);
  if (!Number.isFinite(pct)) return null;

  for (const grade of ACADEMIC_GRADES) {
    const band = GRADE_PERCENTAGE_BANDS[grade];
    if (pct >= band.min && pct <= band.max) return grade;
  }

  // Fallback for pct > 100 (should not happen after clamping, but defensive)
  return 'A_plus';
}

// ─────────────────────────────────────────────────────────────────────────────
// PERCENTAGE INFERENCE FROM GRADE
// Used when marks are absent but grade is provided.
// Returns the midpoint of the grade band.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Infers the normalized percentage midpoint from a letter grade.
 * Returns null for unknown grades.
 *
 * @param {string|null|undefined} grade
 * @returns {number|null}
 */
function inferPercentageFromGrade(grade) {
  if (!grade) return null;
  const band = GRADE_PERCENTAGE_BANDS[grade];
  return band ? band.midpoint : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOARD NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a board_type string.
 * Lowercases and trims whitespace. Returns 'other' for unknown values.
 *
 * @param {string|null|undefined} boardType
 * @param {string[]}              allowedBoards
 * @returns {string}
 */
function normalizeBoard(boardType, allowedBoards) {
  if (!boardType) return 'other';
  const normalized = String(boardType).toLowerCase().trim();
  return allowedBoards.includes(normalized) ? normalized : 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECT NORMALIZATION
// Resolves percentage and grade from whatever the student provided.
// Priority: marks → percentage; grade → inferred percentage.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} NormalizedSubject
 * @property {string}       subject
 * @property {number|null}  marks_obtained
 * @property {number|null}  max_marks
 * @property {string|null}  grade
 * @property {number|null}  percentage       Resolved percentage (marks-derived or grade-inferred)
 * @property {string}       source_type
 * @property {boolean}      is_predicted
 * @property {boolean}      has_marks        Whether actual marks were provided
 * @property {boolean}      has_grade        Whether grade was provided
 * @property {string}       percentage_source 'marks' | 'grade_inference' | 'none'
 */

/**
 * Normalizes a single submitted subject entry into analytics-ready form.
 *
 * @param {Object} subjectInput  Validated subject entry from request body
 * @returns {NormalizedSubject}
 */
function normalizeSubjectEntry(subjectInput) {
  const marksObtained = subjectInput.marks_obtained ?? null;
  const maxMarks      = subjectInput.max_marks      ?? null;
  const grade         = subjectInput.grade          ?? null;
  const sourceType    = subjectInput.source_type    ?? 'manual';
  const isPredicted   = subjectInput.is_predicted   ?? false;

  const hasMarks = marksObtained !== null && maxMarks !== null;
  const hasGrade = grade !== null;

  // Resolve percentage
  let percentage       = null;
  let percentageSource = 'none';
  let resolvedGrade    = grade;

  if (hasMarks) {
    percentage       = computePercentage(marksObtained, maxMarks);
    percentageSource = 'marks';

    // If grade not provided, infer it from percentage
    if (!hasGrade && percentage !== null) {
      resolvedGrade = inferGradeFromPercentage(percentage);
    }
  } else if (hasGrade) {
    // No marks — infer percentage from grade midpoint
    percentage       = inferPercentageFromGrade(grade);
    percentageSource = 'grade_inference';
  }

  return {
    subject:           subjectInput.subject,
    marks_obtained:    marksObtained !== null ? Number(marksObtained) : null,
    max_marks:         maxMarks      !== null ? Number(maxMarks)      : null,
    grade:             resolvedGrade,
    percentage,
    source_type:       sourceType,
    is_predicted:      Boolean(isPredicted),
    has_marks:         hasMarks,
    has_grade:         hasGrade,
    percentage_source: percentageSource,
  };
}

/**
 * Normalizes an entire academic year's subjects array.
 *
 * @param {Object[]} subjects
 * @returns {NormalizedSubject[]}
 */
function normalizeSubjects(subjects) {
  if (!Array.isArray(subjects)) return [];
  return subjects.map((s) => normalizeSubjectEntry(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// YEAR-LEVEL NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} NormalizedAcademicYear
 * @property {string}              academic_year
 * @property {string}              board_type
 * @property {boolean}             is_predicted
 * @property {NormalizedSubject[]} subjects
 * @property {number}              subject_count
 */

/**
 * Normalizes a single academic year payload.
 *
 * @param {string} yearKey    e.g. 'class_10'
 * @param {Object} yearInput  Validated year entry from request body
 * @param {string[]} allowedBoards
 * @returns {NormalizedAcademicYear}
 */
function normalizeAcademicYear(yearKey, yearInput, allowedBoards) {
  const normalizedSubjects = normalizeSubjects(yearInput.subjects ?? []);

  return {
    academic_year: yearKey,
    board_type:    normalizeBoard(yearInput.board_type, allowedBoards),
    is_predicted:  Boolean(yearInput.is_predicted ?? false),
    subjects:      normalizedSubjects,
    subject_count: normalizedSubjects.length,
  };
}

/**
 * Normalizes the full years map from the POST payload.
 *
 * @param {Record<string, Object>} yearsInput  Validated years object from request body
 * @param {string[]}               allowedBoards
 * @returns {NormalizedAcademicYear[]}
 */
function normalizeAcademicYears(yearsInput, allowedBoards) {
  return Object.entries(yearsInput).map(([yearKey, yearInput]) =>
    normalizeAcademicYear(yearKey, yearInput, allowedBoards),
  );
}

module.exports = {
  computePercentage,
  inferGradeFromPercentage,
  inferPercentageFromGrade,
  normalizeBoard,
  normalizeSubjectEntry,
  normalizeSubjects,
  normalizeAcademicYear,
  normalizeAcademicYears,
};
