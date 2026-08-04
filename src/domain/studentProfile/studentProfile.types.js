'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.types.js
 *
 * WP-STD-IMP-03A — Student Repository Foundation & Aggregate Reconstruction
 *
 * JSDoc-only type definitions for the canonical Student Profile shape
 * (WP-STD-IMP-01 v1.1 §2–§4). This repository's existing convention (per
 * WP-STD-IMP-02A §3) does not use dedicated TypeScript types anywhere —
 * `professionalProfile.repository.js` documents its shapes with inline
 * `@param`/`@returns` JSDoc only. This file follows that same convention,
 * centralizing the typedefs so aggregateBuilder.js, mapper.js, metadata.js,
 * and repository.js can all `@typedef {import('./studentProfile.types').StudentProfile}`
 * instead of repeating the shape in every file's JSDoc.
 *
 * This file exports nothing at runtime — it exists purely for IDE/JSDoc
 * tooling. `module.exports = {}` is present only so `require()` does not
 * error if a file requires it by convention.
 */

/**
 * @typedef {Object} AcademicRecordSubject
 * @property {string} subjectName
 * @property {number|null} score
 */

/**
 * @typedef {Object} AcademicRecord
 * @property {string} academicYear
 * @property {AcademicRecordSubject[]} subjects
 */

/**
 * @typedef {Object} AcademicInformation
 * @property {string|null} currentGradeLevel
 * @property {AcademicRecord[]} academicRecords
 * @property {*} legacyAcademicMarks - opaque, transitional (WP-STD-IMP-01 v1.1 §4 row 8)
 */

/**
 * @typedef {Object} ActivityRecord
 * @property {string|null} activityName
 * @property {string|null} activityType
 * @property {string|null} role
 * @property {number|null} duration
 * @property {string|null} evidenceSource
 */

/**
 * @typedef {Object} Activities
 * @property {ActivityRecord[]} activityRecords
 */

/**
 * @typedef {Object} AchievementRecord
 * @property {string|null} achievementName
 * @property {string|null} achievementType
 * @property {number|null} dateAwarded
 * @property {string|null} issuingBody - always null in this design; no source column exists (WP-STD-IMP-01 v1.1 §11)
 */

/**
 * @typedef {Object} Achievements
 * @property {AchievementRecord[]} achievementRecords
 */

/**
 * @typedef {Object} CognitiveAssessmentRecord
 * @property {string|null} assessmentType
 * @property {number|null} score
 * @property {string|null} dateAdministered
 */

/**
 * @typedef {Object} Assessments
 * @property {CognitiveAssessmentRecord[]} cognitiveAssessmentRecords
 */

/**
 * @typedef {Object} CareerAspirations
 * @property {string[]} statedInterests
 * @property {string[]|Object} statedStrengths - declared Array of string; real source is an object of five 1–5 integer scores (disclosed mismatch, WP-STD-IMP-01 v1.1 §11 — not resolved by this module)
 * @property {string[]} careerCuriosities
 * @property {string[]} learningStyles
 */

/**
 * @typedef {Object} StudentProfile
 * @property {string} studentId
 * @property {number} schemaContractVersion
 * @property {string|null} createdAt - ISO timestamp
 * @property {string|null} updatedAt - ISO timestamp
 * @property {string[]} sourceSystemProvenance - subset of SOURCE_SYSTEMS values
 * @property {AcademicInformation} academicInformation
 * @property {Activities} activities
 * @property {Achievements} achievements
 * @property {Assessments} assessments
 * @property {CareerAspirations} careerAspirations
 */

module.exports = {};
