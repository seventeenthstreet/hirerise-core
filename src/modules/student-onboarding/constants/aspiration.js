'use strict';

/**
 * src/modules/student-onboarding/constants/aspiration.js
 *
 * Phase 2 — Aspiration Persistence
 * Single source of truth (backend side) for aspiration enum values.
 *
 * RULES:
 *  - These values must mirror, verbatim:
 *      1. front/src/modules/student-onboarding/steps/aspiration-step.tsx
 *         (CAREER_DOMAINS ids, MOTIVATION_DRIVERS values, TIME_HORIZONS values)
 *      2. career_domain_enum / motivation_driver_enum / time_horizon_enum in
 *         migration 20260901010000_student_aspiration_phase2.sql
 *  - Add values here first, then update the frontend constants and the SQL
 *    migration enums in the same change. Never let the three drift apart.
 *  - Do not remove values; deprecate with a comment instead.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CAREER DOMAINS
// Mirror of: CAREER_DOMAINS ids in aspiration-step.tsx / career_domain_enum
// ─────────────────────────────────────────────────────────────────────────────

const CAREER_DOMAINS = Object.freeze([
  'medicine',
  'engineering',
  'law',
  'arts_design',
  'business',
  'science',
  'teaching',
  'social',
  'defence',
  'sports_fitness',
  'undecided',
]);

// ─────────────────────────────────────────────────────────────────────────────
// MOTIVATION DRIVERS
// Mirror of: MOTIVATION_DRIVERS values in aspiration-step.tsx / motivation_driver_enum
// ─────────────────────────────────────────────────────────────────────────────

const MOTIVATION_DRIVERS = Object.freeze([
  'impact',
  'financial',
  'passion',
  'prestige',
  'autonomy',
]);

// ─────────────────────────────────────────────────────────────────────────────
// TIME HORIZONS
// Mirror of: TIME_HORIZONS values in aspiration-step.tsx / time_horizon_enum
// ─────────────────────────────────────────────────────────────────────────────

const TIME_HORIZONS = Object.freeze([
  'short',
  'medium',
  'long',
  'open',
]);

// ─────────────────────────────────────────────────────────────────────────────
// LIMITS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum number of career interests a student may select.
 * The UI has no hard cap today (a student could toggle every domain except
 * 'undecided'), so this is set to the full domain count minus 'undecided'
 * (which is mutually exclusive with all other selections, enforced by both
 * the frontend's toggleDomain() and the validator below).
 */
const MAX_CAREER_INTERESTS = CAREER_DOMAINS.length - 1;

module.exports = {
  CAREER_DOMAINS,
  MOTIVATION_DRIVERS,
  TIME_HORIZONS,
  MAX_CAREER_INTERESTS,
};
