'use strict';

/**
 * core/src/modules/student-onboarding/helpers/academic-signal-quality.js
 *
 * SIGNAL QUALITY EVALUATOR
 * ─────────────────────────
 * Determines whether a student's submitted academic data meets the minimum
 * threshold required to advance the onboarding session to the next step.
 *
 * WHY THIS IS SEPARATE:
 *   Signal quality rules are a business-logic concern, not a DB or API concern.
 *   Keeping them here means:
 *     • Future intelligence engines can import these rules directly.
 *     • Controllers remain thin.
 *     • Thresholds are tunable in one place (constants/academics.js).
 *
 * SUFFICIENCY RULES (Phase 3A):
 *   Option A: ≥1 committed year has ≥ SUBJECTS_FOR_COMPLETE_YEAR subjects
 *   Option B: ≥ YEARS_FOR_PARTIAL_SUFFICIENCY committed years each with ≥1 subject
 *
 *   "Committed" = is_partial is false.
 *
 * FUTURE EXTENSIONS (do NOT implement now):
 *   • Confidence weighting per subject
 *   • Velocity analysis (grade trend across years)
 *   • Stream affinity pre-scoring
 *   • Missing-subject imputation quality score
 */

const {
  SUBJECTS_FOR_COMPLETE_YEAR,
  YEARS_FOR_PARTIAL_SUFFICIENCY,
  MIN_SUBJECTS_FOR_PARTIAL_YEAR,
} = require('../constants/academics');

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS (JSDoc)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AcademicYearSummary
 * @property {string}  academic_year
 * @property {number}  subject_count
 * @property {boolean} is_partial
 */

/**
 * @typedef {Object} SignalQualityResult
 * @property {boolean} is_sufficient        Whether the signal clears the threshold.
 * @property {string}  reason               Human-readable explanation (for diagnostics).
 * @property {string}  satisfied_by         Which rule satisfied it: 'option_a' | 'option_b' | 'none'.
 * @property {number}  committed_year_count  Number of non-partial years.
 * @property {number}  total_subject_count   Total subject entries across all committed years.
 * @property {number}  max_subjects_in_year  Highest subject count in a single committed year.
 * @property {Object}  thresholds            The thresholds used (for future confidence engines).
 */

// ─────────────────────────────────────────────────────────────────────────────
// EVALUATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates the signal quality of a student's academic submission.
 *
 * Accepts an array of year summaries (not raw DB rows — caller normalizes).
 * This keeps the evaluator pure and testable without DB access.
 *
 * @param {AcademicYearSummary[]} yearSummaries
 * @returns {SignalQualityResult}
 *
 * @example
 * const result = evaluateAcademicSignalQuality([
 *   { academic_year: 'class_10', subject_count: 5, is_partial: false },
 *   { academic_year: 'class_9',  subject_count: 2, is_partial: false },
 * ]);
 * // result.is_sufficient === true  (Option A: class_10 has 5 ≥ 4 subjects)
 */
function evaluateAcademicSignalQuality(yearSummaries) {
  // Normalize input — guard against null/undefined
  const summaries = Array.isArray(yearSummaries) ? yearSummaries : [];

  // Only committed (non-partial) years count toward signal quality
  const committedYears = summaries.filter((y) => y.is_partial === false);

  const committedYearCount = committedYears.length;
  const totalSubjectCount  = committedYears.reduce((sum, y) => sum + (y.subject_count ?? 0), 0);
  const maxSubjectsInYear  = committedYears.reduce(
    (max, y) => Math.max(max, y.subject_count ?? 0),
    0,
  );

  // ── Option A: at least 1 year with SUBJECTS_FOR_COMPLETE_YEAR+ subjects ──
  const satisfiesOptionA = maxSubjectsInYear >= SUBJECTS_FOR_COMPLETE_YEAR;
  if (satisfiesOptionA) {
    return {
      is_sufficient:        true,
      reason:               `Option A satisfied: one year has ${maxSubjectsInYear} subjects (threshold: ${SUBJECTS_FOR_COMPLETE_YEAR}).`,
      satisfied_by:         'option_a',
      committed_year_count: committedYearCount,
      total_subject_count:  totalSubjectCount,
      max_subjects_in_year: maxSubjectsInYear,
      thresholds: {
        subjects_for_complete_year:   SUBJECTS_FOR_COMPLETE_YEAR,
        years_for_partial_sufficiency: YEARS_FOR_PARTIAL_SUFFICIENCY,
        min_subjects_for_partial_year: MIN_SUBJECTS_FOR_PARTIAL_YEAR,
      },
    };
  }

  // ── Option B: at least YEARS_FOR_PARTIAL_SUFFICIENCY years each with ≥1 subject ──
  const yearsWithAnySubject = committedYears.filter(
    (y) => (y.subject_count ?? 0) >= MIN_SUBJECTS_FOR_PARTIAL_YEAR,
  );
  const satisfiesOptionB = yearsWithAnySubject.length >= YEARS_FOR_PARTIAL_SUFFICIENCY;

  if (satisfiesOptionB) {
    return {
      is_sufficient:        true,
      reason:               `Option B satisfied: ${yearsWithAnySubject.length} years each with ≥${MIN_SUBJECTS_FOR_PARTIAL_YEAR} subject (threshold: ${YEARS_FOR_PARTIAL_SUFFICIENCY} years).`,
      satisfied_by:         'option_b',
      committed_year_count: committedYearCount,
      total_subject_count:  totalSubjectCount,
      max_subjects_in_year: maxSubjectsInYear,
      thresholds: {
        subjects_for_complete_year:   SUBJECTS_FOR_COMPLETE_YEAR,
        years_for_partial_sufficiency: YEARS_FOR_PARTIAL_SUFFICIENCY,
        min_subjects_for_partial_year: MIN_SUBJECTS_FOR_PARTIAL_YEAR,
      },
    };
  }

  // ── Neither satisfied ──
  return {
    is_sufficient:        false,
    reason:               `Insufficient signal: ${committedYearCount} committed year(s), max ${maxSubjectsInYear} subjects in any one year. Need Option A (1 year ≥${SUBJECTS_FOR_COMPLETE_YEAR} subjects) or Option B (${YEARS_FOR_PARTIAL_SUFFICIENCY} years ≥${MIN_SUBJECTS_FOR_PARTIAL_YEAR} subject each).`,
    satisfied_by:         'none',
    committed_year_count: committedYearCount,
    total_subject_count:  totalSubjectCount,
    max_subjects_in_year: maxSubjectsInYear,
    thresholds: {
      subjects_for_complete_year:   SUBJECTS_FOR_COMPLETE_YEAR,
      years_for_partial_sufficiency: YEARS_FOR_PARTIAL_SUFFICIENCY,
      min_subjects_for_partial_year: MIN_SUBJECTS_FOR_PARTIAL_YEAR,
    },
  };
}

module.exports = { evaluateAcademicSignalQuality };
