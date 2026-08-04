'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.repository.js
 *
 * WP-STD-IMP-03A — Student Repository Foundation & Aggregate Reconstruction
 *
 * The Student Repository's public read boundary — the sole module any
 * consumer (SPCE, Recommendation Engine, Knowledge Runtime, Presentation,
 * future Career Report/Student CHI) imports for canonical student data,
 * per WP-STD-ARCH-02 §1.1/§1.5 (Single Repository Boundary / Repository
 * Isolation) and WP-STD-IMP-02 §4 (Repository Public Interface).
 *
 * THIS FILE IMPLEMENTS READ METHODS ONLY, per WP-STD-IMP-03A's explicit
 * scope: `getStudentProfile(studentId)` and
 * `getStudentProfileSubdomain(studentId, subdomain)`. Write methods
 * (`writeAcademicInformation`, `writeActivities`, `writeAchievement`,
 * `deleteAchievement`, `writeAssessments`, `writeCareerAspirations` — all
 * designed in WP-STD-IMP-02 §4.2) belong to WP-STD-IMP-03B and are
 * deliberately not present here.
 *
 * Every method returns/accepts canonical-shape objects only
 * (WP-STD-IMP-01 v1.1 §2–§4) — never a table name, a column name, or a
 * Supabase-specific type (Persistence Independence, WP-STD-ARCH-02 §1.2).
 */

const logger = require('../../utils/logger');
const { buildStudentProfile } = require('./studentProfile.aggregateBuilder');
const { VALID_SUBDOMAIN_KEYS } = require('./studentProfile.constants');
const { RepositoryLoadError, AggregateBuildError, ValidationError, MutationError, PersistenceError } = require('./studentProfile.errors');
const mutationBuilder = require('./studentProfile.mutationBuilder');

/**
 * Returns the full canonical StudentProfile for a student, or `null` if
 * the student has no data in any wrapped source (WP-STD-IMP-02 §4.1) — a
 * valid empty state, never an error.
 *
 * Internally executes the Read Pipeline (WP-STD-IMP-02 §7): five parallel
 * subdomain reads, per-subdomain canonical mapping, legacy reconciliation,
 * achievement flattening, metadata computation, and structural validation.
 *
 * Per Read Consistency (WP-STD-ARCH-02 §1.9) and the Error Handling
 * Strategy (WP-STD-IMP-02 §18): if any one wrapped adapter read fails, the
 * whole read fails — this method never returns a profile with a subdomain
 * silently defaulted to empty because of a failure (that would be
 * indistinguishable from a genuinely empty subdomain and could corrupt a
 * downstream readiness evaluation).
 *
 * @param {string} studentId
 * @returns {Promise<import('./studentProfile.types').StudentProfile|null>}
 * @throws {ValidationError} if studentId is missing, or the assembled profile fails structural validation
 * @throws {RepositoryLoadError} if any wrapped adapter read fails
 * @throws {AggregateBuildError} if aggregate assembly fails for a reason other than an adapter read failing
 */
async function getStudentProfile(studentId) {
  try {
    return await buildStudentProfile(studentId);
  } catch (error) {
    if (error instanceof RepositoryLoadError) {
      logger.error('[StudentProfileRepository] getStudentProfile: subdomain load failed', {
        studentId,
        subdomain: error.subdomain,
        error: error.message,
      });
    } else if (error instanceof ValidationError || error instanceof AggregateBuildError) {
      logger.error('[StudentProfileRepository] getStudentProfile: assembly failed', {
        studentId,
        error: error.message,
      });
    } else {
      logger.error('[StudentProfileRepository] getStudentProfile: unexpected failure', {
        studentId,
        error: error?.message ?? String(error),
      });
    }
    throw error;
  }
}

/**
 * Convenience method for a consumer that only needs one subdomain (e.g. a
 * future Academic Analytics capability reading only Academic Information).
 * Internally a thin wrapper around getStudentProfile() that returns a
 * slice, per WP-STD-IMP-02 §4.1 — deliberately NOT a second read pipeline,
 * so there is only one reconciliation code path to keep correct (Read
 * Consistency, WP-STD-ARCH-02 §1.9).
 *
 * @param {string} studentId
 * @param {string} subdomain - one of studentProfile.constants.SUBDOMAIN_KEYS values
 * @returns {Promise<object|null>} just that subdomain's fields, still canonical shape; `null` if the student has no profile data at all
 * @throws {ValidationError} if subdomain is not a recognized key
 */
async function getStudentProfileSubdomain(studentId, subdomain) {
  if (!VALID_SUBDOMAIN_KEYS.includes(subdomain)) {
    throw new ValidationError(`unrecognized subdomain "${subdomain}"`, {
      validSubdomains: VALID_SUBDOMAIN_KEYS,
    });
  }

  const profile = await getStudentProfile(studentId);
  if (!profile) return null;

  return profile[subdomain];
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE METHODS (WP-STD-IMP-03B)
//
// One method per subdomain with a live write authority today, matching
// WP-STD-IMP-01 v1.1 §5's Ownership Matrix exactly (WP-STD-IMP-02 §4.2) —
// no `writeStudentProfile(studentId, fullProfile)` generic method is
// offered, by design (§4.2's own justification: a single generic write
// method would silently reintroduce shared write access this design's
// Single-Ownership enforcement exists to prevent).
//
// Every method below is a thin wrapper: subdomain routing is the method
// name itself (WP-STD-IMP-02 §8 — "not a runtime dispatch table keyed on
// a subdomain string"), validation and delegation happen in
// `studentProfile.mutationBuilder.js`, and this layer's only
// responsibilities are logging and rethrowing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared error-logging helper for write methods, mirroring
 * getStudentProfile()'s error-translation pattern above.
 *
 * @param {string} methodName
 * @param {string} studentId
 * @param {Error} error
 */
function logMutationError(methodName, studentId, error) {
  if (error instanceof MutationError) {
    logger.error(`[StudentProfileRepository] ${methodName}: rejected`, { studentId, error: error.message });
  } else if (error instanceof PersistenceError) {
    logger.error(`[StudentProfileRepository] ${methodName}: persistence failed`, { studentId, error: error.message });
  } else {
    logger.error(`[StudentProfileRepository] ${methodName}: unexpected failure`, {
      studentId,
      error: error?.message ?? String(error),
    });
  }
}

/**
 * Writes Academic Information. Delegates to `academic.repository.js` for
 * `academicRecords[]`; rejects if `currentGradeLevel` is present, since no
 * write adapter exists for it under this design (WP-STD-IMP-02 §10).
 *
 * @param {string} studentId
 * @param {{ currentGradeLevel?: string|null, academicRecords?: object[] }} partial
 * @returns {Promise<{ written: boolean, fields: string[] }>}
 * @throws {MutationError} on a structurally invalid payload
 * @throws {PersistenceError} if the underlying adapter write fails, or no write adapter exists for a requested field
 */
async function writeAcademicInformation(studentId, partial) {
  try {
    return await mutationBuilder.writeAcademicInformation(studentId, partial);
  } catch (error) {
    logMutationError('writeAcademicInformation', studentId, error);
    throw error;
  }
}

/**
 * Writes Activities. Delegates to `activity.repository.js`.
 *
 * @param {string} studentId
 * @param {{ activityRecords?: object[] }} partial
 * @returns {Promise<{ written: boolean, fields: string[] }>}
 * @throws {MutationError} on a structurally invalid payload
 * @throws {PersistenceError} if the underlying adapter write fails
 */
async function writeActivities(studentId, partial) {
  try {
    return await mutationBuilder.writeActivities(studentId, partial);
  } catch (error) {
    logMutationError('writeActivities', studentId, error);
    throw error;
  }
}

/**
 * Adds a single achievement against an existing activity. Delegates to
 * `activity.repository.js`. `activityKey` is required — it reflects the
 * real FK constraint the underlying table enforces (WP-STD-IMP-02 §6.5),
 * even though the canonical read-side shape does not carry it.
 *
 * @param {string} studentId
 * @param {string} activityKey
 * @param {{ achievementName: string, achievementType: string, dateAwarded?: number|null, issuingBody?: string|null }} achievement
 * @returns {Promise<{ written: boolean, achievementId: string }>}
 * @throws {MutationError} on a structurally invalid payload, or an `activityKey` with no matching activity
 * @throws {PersistenceError} if the underlying adapter write fails
 */
async function writeAchievement(studentId, activityKey, achievement) {
  try {
    return await mutationBuilder.writeAchievement(studentId, activityKey, achievement);
  } catch (error) {
    logMutationError('writeAchievement', studentId, error);
    throw error;
  }
}

/**
 * Deletes a single achievement. Delegates to `activity.repository.js`.
 *
 * @param {string} studentId
 * @param {string} achievementId
 * @returns {Promise<{ deleted: boolean }>}
 * @throws {MutationError} on a structurally invalid payload
 * @throws {PersistenceError} if the underlying adapter delete fails
 */
async function deleteAchievement(studentId, achievementId) {
  try {
    return await mutationBuilder.deleteAchievement(studentId, achievementId);
  } catch (error) {
    logMutationError('deleteAchievement', studentId, error);
    throw error;
  }
}

/**
 * Writes Assessments (Cognitive). Delegates to `cognitive.repository.js`.
 * Each entry requires `selectedOptionKeys` in addition to the canonical
 * `assessmentType` — the real, non-canonical write constraint disclosed
 * in `studentProfile.writeValidation.js`'s file header.
 *
 * @param {string} studentId
 * @param {{ cognitiveAssessmentRecords?: object[] }} partial
 * @returns {Promise<{ written: boolean, fields: string[] }>}
 * @throws {MutationError} on a structurally invalid payload
 * @throws {PersistenceError} if the underlying adapter write fails
 */
async function writeAssessments(studentId, partial) {
  try {
    return await mutationBuilder.writeAssessments(studentId, partial);
  } catch (error) {
    logMutationError('writeAssessments', studentId, error);
    throw error;
  }
}

/**
 * Writes Career Aspirations. **Always rejects today** — no write adapter
 * exists for this subdomain under this design (WP-STD-IMP-02 §10, §12.3,
 * §21). This method exists as the documented, mechanical integration
 * point for a future v2 aspiration backend; it is not a functioning write
 * path yet, and this is a deliberate design fact, not a bug.
 *
 * @param {string} studentId
 * @param {{ statedInterests?: string[], statedStrengths?: *, careerCuriosities?: string[], learningStyles?: string[] }} partial
 * @returns {Promise<never>}
 * @throws {MutationError} on a structurally invalid payload
 * @throws {PersistenceError} always, if the payload is structurally valid — no write adapter exists yet
 */
async function writeCareerAspirations(studentId, partial) {
  try {
    return await mutationBuilder.writeCareerAspirations(studentId, partial);
  } catch (error) {
    logMutationError('writeCareerAspirations', studentId, error);
    throw error;
  }
}

module.exports = {
  getStudentProfile,
  getStudentProfileSubdomain,
  writeAcademicInformation,
  writeActivities,
  writeAchievement,
  deleteAchievement,
  writeAssessments,
  writeCareerAspirations,
};
