'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.schema.js
 *
 * WP-STD-IMP-03A — Student Repository Foundation & Aggregate Reconstruction
 *
 * Canonical Student Profile shape, per the field-level schema approved in
 * WP-STD-IMP-01 v1.1 ("Canonical Student Profile Schema Design"). This file
 * does not decide persistence strategy (that is aggregateBuilder.js's /
 * repository.js's job) — it defines the one aggregate root plus five
 * business subdomains WP-STD-IMP-01 v1.1 §2–§4 already designed:
 *
 *   Aggregate Root:     studentId, schemaContractVersion, createdAt,
 *                        updatedAt, sourceSystemProvenance
 *   1. Academic Information
 *   2. Activities
 *   3. Achievements
 *   4. Assessments (Cognitive)
 *   5. Career Aspirations
 *
 * This is the student-side field-level analogue of
 * `professionalProfile.schema.js` — directly modeled on it per
 * WP-STD-IMP-02A §7's recommendation ("template exists at
 * professionalProfile.schema.js").
 *
 * This is a PURE data-shape module — no I/O, no DB, no HTTP.
 */

const { SCHEMA_CONTRACT_VERSION, SUBDOMAIN_KEYS, SOURCE_SYSTEMS } = require('./studentProfile.constants');

/**
 * Returns an empty canonical Student Profile.
 *
 * Every business-domain field is nullable/optional and defaults to `null`
 * or `[]` per WP-STD-IMP-01 v1.1 §4's Default column — reconstruction never
 * fails because a subdomain has no data (WP-STD-IMP-02 §6.6): a student who
 * has only ever completed the Cognitive step has a fully valid
 * `StudentProfile` with four empty subdomains and one populated one.
 *
 * Callers overlay only the subdomains they actually have data for
 * (see aggregateBuilder.js) — this factory never invents data.
 *
 * @param {string} studentId
 * @returns {object} Canonical Student Profile, fully empty
 */
function emptyStudentProfile(studentId) {
  return {
    // ── Aggregate Root (WP-STD-IMP-01 v1.1 §2.1) ──────────────────────────
    studentId: studentId ?? null,
    schemaContractVersion: SCHEMA_CONTRACT_VERSION,
    createdAt: null,
    updatedAt: null,
    sourceSystemProvenance: [],

    // ── Academic Information (§3.1) ───────────────────────────────────────
    [SUBDOMAIN_KEYS.ACADEMIC_INFORMATION]: {
      currentGradeLevel: null,
      academicRecords: [],
      legacyAcademicMarks: null,
    },

    // ── Activities (§3.2) ──────────────────────────────────────────────────
    [SUBDOMAIN_KEYS.ACTIVITIES]: {
      activityRecords: [],
    },

    // ── Achievements (§3.3) ───────────────────────────────────────────────
    [SUBDOMAIN_KEYS.ACHIEVEMENTS]: {
      achievementRecords: [],
    },

    // ── Assessments / Cognitive (§3.4) ────────────────────────────────────
    [SUBDOMAIN_KEYS.ASSESSMENTS]: {
      cognitiveAssessmentRecords: [],
    },

    // ── Career Aspirations (§3.5) ─────────────────────────────────────────
    [SUBDOMAIN_KEYS.CAREER_ASPIRATIONS]: {
      statedInterests: [],
      statedStrengths: [],
      careerCuriosities: [],
      learningStyles: [],
    },
  };
}

module.exports = Object.freeze({
  SCHEMA_CONTRACT_VERSION,
  SUBDOMAIN_KEYS,
  SOURCE_SYSTEMS,
  emptyStudentProfile,
});
