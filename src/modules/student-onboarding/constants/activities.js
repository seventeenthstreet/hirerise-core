'use strict';

/**
 * core/src/modules/student-onboarding/constants/activities.js
 *
 * SINGLE SOURCE OF TRUTH — Activities & Achievement Intelligence (Phase 3B)
 *
 * Rules:
 *  - All enum values here MUST mirror the SQL enums in migration
 *    20260523000001_student_activities_phase3b.sql
 *  - All enum values here MUST mirror the TypeScript types in
 *    front/src/modules/student-onboarding/activities/types/index.ts
 *  - CONTRACT: Never remove values. Add new values to the END of each array.
 *  - Deprecate by adding a comment — never delete.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TAXONOMY CATEGORIES
// Mirror of: activity_category_enum SQL enum
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVITY_CATEGORIES = Object.freeze([
  'technical',
  'creative',
  'leadership',
  'academic',
  'social',
  'athletic',
]);

// ─────────────────────────────────────────────────────────────────────────────
// PROFICIENCY LEVELS
// Mirror of: proficiency_level_enum SQL enum
// Scale: beginner(1) → developing(2) → proficient(3) → advanced(4) → expert(5)
// ─────────────────────────────────────────────────────────────────────────────

const PROFICIENCY_LEVELS = Object.freeze([
  'beginner',
  'developing',
  'proficient',
  'advanced',
  'expert',
]);

/**
 * Numeric weights for proficiency levels.
 * Used by signal normalizers — never in UI rendering.
 *
 * @type {Record<string, number>}
 */
const PROFICIENCY_WEIGHTS = Object.freeze({
  beginner:   1,
  developing: 2,
  proficient: 3,
  advanced:   4,
  expert:     5,
});

// ─────────────────────────────────────────────────────────────────────────────
// LEADERSHIP LEVELS
// Mirror of: leadership_level_enum SQL enum
// ─────────────────────────────────────────────────────────────────────────────

const LEADERSHIP_LEVELS = Object.freeze([
  'none',
  'participant',
  'coordinator',
  'lead',
  'captain',
  'founder',
]);

/**
 * Numeric weights for leadership levels.
 * Used by signal normalizers — never in UI rendering.
 *
 * @type {Record<string, number>}
 */
const LEADERSHIP_WEIGHTS = Object.freeze({
  none:        0,
  participant: 1,
  coordinator: 2,
  lead:        3,
  captain:     4,
  founder:     5,
});

// ─────────────────────────────────────────────────────────────────────────────
// ACHIEVEMENT LEVELS
// Mirror of: achievement_level_enum SQL enum
// Scale: participation(0) → international(6)
// ─────────────────────────────────────────────────────────────────────────────

const ACHIEVEMENT_LEVELS = Object.freeze([
  'participation',
  'school',
  'inter_school',
  'district',
  'state',
  'national',
  'international',
]);

/**
 * Numeric weights for achievement levels.
 * Used by normalizeAchievement() signal extractor — never in UI rendering.
 *
 * @type {Record<string, number>}
 */
const ACHIEVEMENT_LEVEL_WEIGHTS = Object.freeze({
  participation: 0,
  school:        1,
  inter_school:  2,
  district:      3,
  state:         4,
  national:      5,
  international: 6,
});

// ─────────────────────────────────────────────────────────────────────────────
// ACHIEVEMENT POSITIONS
// Mirror of: achievement_position_enum SQL enum
// ─────────────────────────────────────────────────────────────────────────────

const ACHIEVEMENT_POSITIONS = Object.freeze([
  'participant',
  'finalist',
  'runner_up',
  'winner',
]);

/**
 * Numeric weights for achievement positions.
 * Used by normalizeAchievement() signal extractor — never in UI rendering.
 *
 * @type {Record<string, number>}
 */
const ACHIEVEMENT_POSITION_WEIGHTS = Object.freeze({
  participant: 0,
  finalist:    1,
  runner_up:   2,
  winner:      3,
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION CONSTRAINTS
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum months a student may report for an activity. */
const MIN_DURATION_MONTHS = 0;

/** Safeguard cap: 20 years × 12 months. */
const MAX_DURATION_MONTHS = 240;

/** Maximum weekly hours reported (sanity check). */
const MAX_WEEKLY_FREQUENCY = 168; // can't exceed hours in a week

/** Minimum achievement year (reasonable floor). */
const MIN_ACHIEVEMENT_YEAR = 2000;

/** Maximum achievement year (current year + 1 for predicted/upcoming). */
const MAX_ACHIEVEMENT_YEAR = new Date().getFullYear() + 1;

/** Maximum characters for achievement title. */
const MAX_ACHIEVEMENT_TITLE_LENGTH = 200;

/** Maximum characters for reflection free-text. */
const MAX_REFLECTION_TEXT_LENGTH = 500;

/** Minimum activities required for step completion (signal sufficiency). */
const MIN_ACTIVITIES_FOR_COMMIT = 1;

/** Maximum number of activities a student may add. */
const MAX_ACTIVITIES_PER_STUDENT = 20;

/** Maximum achievements per activity. */
const MAX_ACHIEVEMENTS_PER_ACTIVITY = 10;

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  ACTIVITY_CATEGORIES,
  PROFICIENCY_LEVELS,
  PROFICIENCY_WEIGHTS,
  LEADERSHIP_LEVELS,
  LEADERSHIP_WEIGHTS,
  ACHIEVEMENT_LEVELS,
  ACHIEVEMENT_LEVEL_WEIGHTS,
  ACHIEVEMENT_POSITIONS,
  ACHIEVEMENT_POSITION_WEIGHTS,
  MIN_DURATION_MONTHS,
  MAX_DURATION_MONTHS,
  MAX_WEEKLY_FREQUENCY,
  MIN_ACHIEVEMENT_YEAR,
  MAX_ACHIEVEMENT_YEAR,
  MAX_ACHIEVEMENT_TITLE_LENGTH,
  MAX_REFLECTION_TEXT_LENGTH,
  MIN_ACTIVITIES_FOR_COMMIT,
  MAX_ACTIVITIES_PER_STUDENT,
  MAX_ACHIEVEMENTS_PER_ACTIVITY,
};
