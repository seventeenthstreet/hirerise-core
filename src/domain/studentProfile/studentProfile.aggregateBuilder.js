'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.aggregateBuilder.js
 *
 * WP-STD-IMP-03A — Student Repository Foundation & Aggregate Reconstruction
 *
 * Aggregate Builder: implements the Read Pipeline and Aggregate
 * Reconstruction Model exactly as designed by WP-STD-IMP-02 §6–§7, §9,
 * §16 — parallel loading, per-subdomain mapping (delegated to
 * studentProfile.mapper.js), legacy reconciliation, achievement
 * flattening (delegated to the mapper), metadata computation (delegated
 * to studentProfile.metadata.js), and defensive structural validation.
 *
 * PERSISTENCE STRATEGY: Wrap (WP-STD-IMP-02 §10). This module composes the
 * *existing*, unmodified subdomain repositories
 * (academic.repository.js, activity.repository.js, cognitive.repository.js)
 * plus one new, thin, read-only adapter over the legacy
 * `student_career_profiles` table (WP-STD-IMP-02 §9's "new thin
 * legacy-read adapter" for Academic Information's legacy half and Career
 * Aspirations). No new table, migration, or write path is introduced.
 *
 * studentProfile.repository.js is the only intended caller of this module.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

const academicRepository = require('../../modules/student-onboarding/repositories/academic.repository');
const activityRepository = require('../../modules/student-onboarding/repositories/activity.repository');
const cognitiveRepository = require('../../modules/student-onboarding/repositories/cognitive.repository');

const { emptyStudentProfile, SUBDOMAIN_KEYS } = require('./studentProfile.schema');
const { LEGACY_CAREER_PROFILES_TABLE } = require('./studentProfile.constants');
const {
  mapAcademicInformation,
  mapActivities,
  mapAchievements,
  mapAssessments,
  mapCareerAspirations,
} = require('./studentProfile.mapper');
const { computeCreatedAt, computeUpdatedAt, computeSourceSystemProvenance } = require('./studentProfile.metadata');
const { RepositoryLoadError, AggregateBuildError, ValidationError } = require('./studentProfile.errors');

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY ADAPTER — read-only over student_career_profiles
// (WP-STD-IMP-02 §9; source for currentGradeLevel, legacyAcademicMarks, and
// all four Career Aspirations fields. Write path — the
// complete_student_onboarding RPC via student-onboarding.routes.js — is
// untouched, per WP-STD-IMP-02 §13.1.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the legacy System 1 row for a student, if any.
 *
 * @param {string} studentId
 * @returns {Promise<object|null>}
 */
async function fetchLegacyCareerProfile(studentId) {
  const { data, error } = await supabase
    .from(LEGACY_CAREER_PROFILES_TABLE)
    .select('grade, academic_marks, interests, strengths, career_curiosities, learning_styles, created_at, updated_at')
    .eq('user_id', studentId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL LOAD ORCHESTRATION (WP-STD-IMP-02 §6.1, §7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps a single subdomain loader so any failure is reported as a typed
 * RepositoryLoadError naming the subdomain, per the Error Handling
 * Strategy (WP-STD-IMP-02 §18): "the whole read fails ... it does not
 * return a profile with that one subdomain silently defaulted to empty."
 *
 * @param {string} subdomain
 * @param {() => Promise<*>} loader
 * @returns {Promise<*>}
 */
async function loadSubdomain(subdomain, loader) {
  try {
    return await loader();
  } catch (cause) {
    throw new RepositoryLoadError(subdomain, cause);
  }
}

/**
 * Issues all five (four, since aggregate-root metadata is derived, not a
 * sixth read — WP-STD-IMP-02 §6.1) subdomain reads in parallel, per
 * WP-STD-IMP-02 §6.1: "no read depends on another read's result, so they
 * are not sequenced." Uses Promise.all (not allSettled) so that any single
 * rejection fails the whole load immediately — Read Consistency
 * (WP-STD-ARCH-02 §1.9) requires never returning a blended, partially
 * failed snapshot.
 *
 * @param {string} studentId
 * @returns {Promise<{legacyRow: object|null, academicRaw: object, activityRaw: object, cognitiveRaw: object}>}
 */
async function loadAllSources(studentId) {
  const [legacyRow, academicRaw, activityRaw, cognitiveRaw] = await Promise.all([
    loadSubdomain('legacy', () => fetchLegacyCareerProfile(studentId)),
    loadSubdomain(SUBDOMAIN_KEYS.ACADEMIC_INFORMATION, () => academicRepository.fetchAcademicData(supabase, studentId)),
    loadSubdomain(SUBDOMAIN_KEYS.ACTIVITIES, () => activityRepository.fetchStudentActivityData(supabase, studentId)),
    loadSubdomain(SUBDOMAIN_KEYS.ASSESSMENTS, () => cognitiveRepository.fetchStudentCognitiveData(supabase, studentId)),
  ]);

  return { legacyRow, academicRaw, activityRaw, cognitiveRaw };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPTY-STATE DETECTION (WP-STD-IMP-02 §4.1, §6.6, §18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A student has "no data in any wrapped source" (WP-STD-IMP-02 §4.1's
 * `null`-return case, distinct from a read failure) only if every source
 * contributed zero rows. This is checked once, from the raw loaded data,
 * before any mapping is performed.
 *
 * @param {{legacyRow: object|null, academicRaw: object, activityRaw: object, cognitiveRaw: object}} sources
 * @returns {boolean}
 */
function hasNoData({ legacyRow, academicRaw, activityRaw, cognitiveRaw }) {
  const hasLegacy = legacyRow !== null && legacyRow !== undefined;
  const hasAcademic = (academicRaw?.records?.length ?? 0) > 0 || (academicRaw?.subjects?.length ?? 0) > 0;
  const hasActivities =
    (activityRaw?.activities?.length ?? 0) > 0 || (activityRaw?.achievements?.length ?? 0) > 0;
  const hasCognitive = (cognitiveRaw?.responses?.length ?? 0) > 0 || cognitiveRaw?.signals != null;

  return !hasLegacy && !hasAcademic && !hasActivities && !hasCognitive;
}

// ─────────────────────────────────────────────────────────────────────────────
// METADATA ASSEMBLY (WP-STD-IMP-02 §16)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collects every row-level {created_at, updated_at} pair across all four
 * loaded sources, for computeCreatedAt()/computeUpdatedAt() to min()/max()
 * over (WP-STD-IMP-02 §16).
 *
 * @param {{legacyRow: object|null, academicRaw: object, activityRaw: object, cognitiveRaw: object}} sources
 * @returns {{createdAt: string|null, updatedAt: string|null}[]}
 */
function collectSourceTimestamps({ legacyRow, academicRaw, activityRaw, cognitiveRaw }) {
  const timestamps = [];

  if (legacyRow) {
    timestamps.push({ createdAt: legacyRow.created_at ?? null, updatedAt: legacyRow.updated_at ?? null });
  }
  for (const r of academicRaw?.records ?? []) {
    timestamps.push({ createdAt: r.created_at ?? null, updatedAt: r.updated_at ?? null });
  }
  for (const s of academicRaw?.subjects ?? []) {
    timestamps.push({ createdAt: s.created_at ?? null, updatedAt: s.updated_at ?? null });
  }
  for (const a of activityRaw?.activities ?? []) {
    timestamps.push({ createdAt: a.created_at ?? null, updatedAt: a.updated_at ?? null });
  }
  for (const a of activityRaw?.achievements ?? []) {
    timestamps.push({ createdAt: a.created_at ?? null, updatedAt: a.updated_at ?? null });
  }
  for (const r of cognitiveRaw?.responses ?? []) {
    timestamps.push({ createdAt: r.created_at ?? null, updatedAt: r.updated_at ?? null });
  }
  if (cognitiveRaw?.signals) {
    timestamps.push({ createdAt: cognitiveRaw.signals.created_at ?? null, updatedAt: cognitiveRaw.signals.updated_at ?? null });
  }

  return timestamps;
}

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL VALIDATION (WP-STD-IMP-02 §7, §15 — defensive, read-time only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirms the assembled StudentProfile matches the canonical shape's
 * required fields before it is returned, per WP-STD-IMP-02 §7's Read
 * Pipeline: "a defensive internal check, not a gate that can reject
 * legitimate wrapped data, since the mapping functions ... are what
 * guarantee shape compliance." This never validates business plausibility
 * or sufficiency — only that the four required Aggregate Root fields and
 * five subdomain containers are present, per WP-STD-IMP-01 v1.1 §7's rule
 * that only identity/version/audit fields are required.
 *
 * @param {object} profile
 * @throws {ValidationError}
 */
function validateStudentProfileShape(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new ValidationError('assembled profile is not an object');
  }
  if (!profile.studentId) {
    throw new ValidationError('studentId is required and must be non-empty');
  }
  if (typeof profile.schemaContractVersion !== 'number') {
    throw new ValidationError('schemaContractVersion must be a number');
  }
  if (!Array.isArray(profile.sourceSystemProvenance)) {
    throw new ValidationError('sourceSystemProvenance must be an array');
  }

  for (const key of Object.values(SUBDOMAIN_KEYS)) {
    if (!profile[key] || typeof profile[key] !== 'object') {
      throw new ValidationError(`subdomain "${key}" is missing or not an object`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the full canonical StudentProfile for a student, or returns
 * `null` if the student has no data in any wrapped source (WP-STD-IMP-02
 * §4.1) — this is a valid empty state, not an error.
 *
 * @param {string} studentId
 * @returns {Promise<import('./studentProfile.types').StudentProfile|null>}
 * @throws {RepositoryLoadError} if any wrapped adapter read fails
 * @throws {AggregateBuildError} if mapping/assembly fails unexpectedly
 * @throws {ValidationError} if the assembled object fails structural validation
 */
async function buildStudentProfile(studentId) {
  if (!studentId) {
    throw new ValidationError('studentId is required');
  }

  const sources = await loadAllSources(studentId);

  if (hasNoData(sources)) {
    return null;
  }

  let profile;
  try {
    profile = emptyStudentProfile(studentId);

    profile[SUBDOMAIN_KEYS.ACADEMIC_INFORMATION] = mapAcademicInformation(sources.academicRaw, sources.legacyRow);
    profile[SUBDOMAIN_KEYS.ACTIVITIES] = mapActivities(sources.activityRaw?.activities);
    profile[SUBDOMAIN_KEYS.ACHIEVEMENTS] = mapAchievements(sources.activityRaw?.achievements);
    profile[SUBDOMAIN_KEYS.ASSESSMENTS] = mapAssessments(sources.cognitiveRaw?.responses);
    profile[SUBDOMAIN_KEYS.CAREER_ASPIRATIONS] = mapCareerAspirations(sources.legacyRow);

    const sourceTimestamps = collectSourceTimestamps(sources);
    profile.createdAt = computeCreatedAt(sourceTimestamps);
    profile.updatedAt = computeUpdatedAt(sourceTimestamps);
    profile.sourceSystemProvenance = computeSourceSystemProvenance({
      hasLegacyData: sources.legacyRow !== null && sources.legacyRow !== undefined,
      hasV2Data:
        (sources.academicRaw?.records?.length ?? 0) > 0 ||
        (sources.academicRaw?.subjects?.length ?? 0) > 0 ||
        (sources.activityRaw?.activities?.length ?? 0) > 0 ||
        (sources.activityRaw?.achievements?.length ?? 0) > 0 ||
        (sources.cognitiveRaw?.responses?.length ?? 0) > 0 ||
        sources.cognitiveRaw?.signals != null,
    });
  } catch (cause) {
    if (cause instanceof ValidationError || cause instanceof RepositoryLoadError) throw cause;
    logger.error('[StudentProfileAggregateBuilder] aggregate assembly failed', {
      studentId,
      error: cause?.message,
    });
    throw new AggregateBuildError(cause?.message ?? String(cause), { studentId });
  }

  validateStudentProfileShape(profile);

  return profile;
}

module.exports = {
  buildStudentProfile,
  // Exported for unit testing only — not part of the module's intended
  // public surface (studentProfile.repository.js is the sole consumer of
  // buildStudentProfile in production code).
  fetchLegacyCareerProfile,
  hasNoData,
  collectSourceTimestamps,
  validateStudentProfileShape,
};
