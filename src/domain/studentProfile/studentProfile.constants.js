'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.constants.js
 *
 * WP-STD-IMP-03A — Student Repository Foundation & Aggregate Reconstruction
 *
 * Shared constants for the Student Repository module. No business logic.
 *
 * Authoritative inputs:
 *   - WP-STD-IMP-01 v1.1 §2.1 (schemaContractVersion, sourceSystemProvenance)
 *   - WP-STD-IMP-02 §16 (metadata strategy — computed, not stored)
 *   - WP-STD-IMP-02 §9 (subdomain loading strategy — legacy table name)
 */

/**
 * The canonical Student Profile shape's own contract version (WP-STD-IMP-01
 * v1.1 §2.1). This versions the SHAPE itself, never an individual student's
 * data — bumped only when this repository's mapping logic (mapper.js)
 * changes an existing field's type, nullability, or meaning (WP-STD-IMP-02
 * §17). Adding a new optional field does not require a bump.
 */
const SCHEMA_CONTRACT_VERSION = 1;

/**
 * Canonical subdomain keys, matching WP-STD-ARCH-01 §6.2's five named
 * subdomains exactly. Used as the top-level keys under a StudentProfile
 * object, and as the accepted `subdomain` argument to
 * getStudentProfileSubdomain().
 */
const SUBDOMAIN_KEYS = Object.freeze({
  ACADEMIC_INFORMATION: 'academicInformation',
  ACTIVITIES: 'activities',
  ACHIEVEMENTS: 'achievements',
  ASSESSMENTS: 'assessments',
  CAREER_ASPIRATIONS: 'careerAspirations',
});

/** All valid subdomain keys, for validation. */
const VALID_SUBDOMAIN_KEYS = Object.freeze(Object.values(SUBDOMAIN_KEYS));

/**
 * Source-system provenance enum (WP-STD-IMP-01 v1.1 §2.1, §4 row 5).
 * Retained only for the duration of migration — see WP-STD-ARCH-02 §10.
 * `FRONTEND_DIRECT` is never emitted by this design (WP-STD-IMP-02 §13.8 —
 * no accommodation designed; reserved for a future re-verification finding).
 */
const SOURCE_SYSTEMS = Object.freeze({
  LEGACY_ONBOARDING: 'legacy_onboarding',
  ONBOARDING_V2: 'onboarding_v2',
  FRONTEND_DIRECT: 'frontend_direct',
});

/**
 * Legacy System 1 table wrapped read-only by the new legacy adapter inside
 * aggregateBuilder.js — source for currentGradeLevel, legacyAcademicMarks,
 * and all four Career Aspirations fields (WP-STD-IMP-02 §9's "new thin
 * legacy-read adapter" for Academic Information's legacy half and Career
 * Aspirations). This table is read-only here; its write path
 * (`complete_student_onboarding` RPC, via student-onboarding.routes.js)
 * is untouched (WP-STD-IMP-02 §13.1).
 */
const LEGACY_CAREER_PROFILES_TABLE = 'student_career_profiles';

module.exports = Object.freeze({
  SCHEMA_CONTRACT_VERSION,
  SUBDOMAIN_KEYS,
  VALID_SUBDOMAIN_KEYS,
  SOURCE_SYSTEMS,
  LEGACY_CAREER_PROFILES_TABLE,
});
