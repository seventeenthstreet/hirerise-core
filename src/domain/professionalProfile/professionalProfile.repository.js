'use strict';

/**
 * @file src/domain/professionalProfile/professionalProfile.repository.js
 *
 * WP-PRO-07 — Professional Profile Normalization Engine
 *
 * Durable persistence for the canonical Professional Profile, targeting
 * `user_profiles` per WP-PRO-04 §8's Domain Model ADR:
 *
 *   - Sections with an existing dedicated column write DIRECTLY to that
 *     column (Skills → user_profiles.skills, Experience → .experience,
 *     Employment Preferences → work_mode/preferred_work_location/
 *     expected_salary_lpa/job_search_timeline, Languages → .languages,
 *     Career Goals → expected_role_ids/target_role, and the parts of
 *     Personal Information that already have columns: display_name, email,
 *     current_city, current_job_title, current_company,
 *     work_authorisation).
 *   - Sections with NO existing schema presence (Education, Projects,
 *     Certifications — confirmed net-new per WP-PRO-04 §6) — plus the one
 *     Personal Information field with no column (phone), the parts of
 *     Resume Metadata that aren't already dedicated columns, and
 *     Completion Metadata's acquisition-provenance fields — land inside the
 *     dormant `user_profiles.professional_profile` jsonb column, exactly as
 *     WP-PRO-04 §8 decided. Dedicated-column sections are NOT duplicated
 *     inside the jsonb blob (per the same ADR).
 *
 * BOUNDARY RULE ENFORCEMENT: `careerIntelligenceMetadata` is never written
 * by this repository's acquisition-facing write path
 * (`saveProfessionalProfileSections`). Any attempt to include it is
 * stripped and logged — see `ACQUISITION_WRITABLE_SECTIONS` in
 * professionalProfile.schema.js. This is the enforcement mechanism behind
 * WP-PRO-04 §5's "no downstream module depends on acquisition method"
 * guarantee: acquisition methods physically cannot touch the
 * intelligence-derived section.
 *
 * All writes are read-modify-write against the `professional_profile` jsonb
 * column (no jsonb merge operator is assumed available), scoped to only the
 * keys this write touches — any key this write doesn't touch (including a
 * future `careerIntelligenceMetadata` written by a Career Intelligence
 * module) is preserved untouched.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');
const { authoritativeUpsert } = require('../../lib/db/authoritativeMutation');
const { resolveExpectedRoleIdsFromTitle } = require('../../shared/utils/roleCatalog');
const {
  PROFILE_SECTIONS,
  ACQUISITION_WRITABLE_SECTIONS,
} = require('./professionalProfile.schema');

const TABLE_PROFILES = 'user_profiles';

// Sections that live entirely inside the professional_profile jsonb blob
// (no dedicated relational column exists for them today — WP-PRO-04 §6).
const JSONB_ONLY_SECTIONS = new Set([
  PROFILE_SECTIONS.EDUCATION,
  PROFILE_SECTIONS.PROJECTS,
  PROFILE_SECTIONS.CERTIFICATIONS,
]);

function nowISO() {
  return new Date().toISOString();
}

/**
 * Read the current professional_profile jsonb blob + every dedicated
 * column this repository owns, for a given user.
 *
 * @param {string} userId
 * @returns {Promise<object|null>} raw user_profiles row (selected columns only), or null
 */
async function readRow(userId) {
  const { data, error } = await supabase
    .from(TABLE_PROFILES)
    .select([
      'id',
      'display_name', 'email', 'current_city', 'current_job_title', 'current_company',
      'work_authorisation',
      'skills',
      'experience',
      'languages',
      'expected_role_ids', 'target_role',
      'work_mode', 'preferred_work_location', 'expected_salary_lpa', 'job_search_timeline',
      'resume_id', 'latest_resume_id', 'resume_uploaded',
      'professional_profile',
    ].join(','))
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.error('[ProfessionalProfileRepository] read failed', { userId, error: error.message });
    throw error;
  }

  return data;
}

/**
 * Persist a partial canonical Professional Profile (as produced by
 * professionalProfile.normalizer.js) for a user. This is the single write
 * path every acquisition method (Resume Upload, Guided Builder, existing
 * Professional onboarding intake) must go through — Task 1/Task 2.
 *
 * @param {string} userId
 * @param {object} partialProfile - output of a professionalProfile.normalizer.js function (or several merged together)
 * @param {object} [opts]
 * @param {string} [opts.source] - acquisition method label, for logging only
 * @returns {Promise<object>} the dedicated-column payload + jsonb payload that were written
 */
async function saveProfessionalProfileSections(userId, partialProfile, opts = {}) {
  if (!userId) {
    throw new Error('[ProfessionalProfileRepository] userId is required');
  }
  if (!partialProfile || typeof partialProfile !== 'object') {
    return { written: false, reason: 'empty partial profile' };
  }

  // ── Boundary enforcement: strip any section an acquisition method must
  // not write (Career Intelligence Metadata; raw Completion flags belong to
  // onboarding.helpers.js#persistCompletionIfReady, not this engine). ──────
  const rejectedSections = [];
  const sections = {};
  for (const [key, value] of Object.entries(partialProfile)) {
    if (key === 'userId') continue;
    if (!ACQUISITION_WRITABLE_SECTIONS.includes(key)) {
      rejectedSections.push(key);
      continue;
    }
    sections[key] = value;
  }
  if (rejectedSections.length) {
    logger.warn('[ProfessionalProfileRepository] rejected non-acquisition-writable section(s)', {
      userId,
      source: opts.source ?? 'unknown',
      rejectedSections,
    });
  }

  if (Object.keys(sections).length === 0) {
    return { written: false, reason: 'no writable sections after boundary filtering' };
  }

  const columnPayload = { id: userId, updated_at: nowISO() };
  const jsonbPatch = {};

  // ── Personal Information ────────────────────────────────────────────────
  const pi = sections[PROFILE_SECTIONS.PERSONAL_INFORMATION];
  if (pi) {
    if (pi.fullName !== undefined) columnPayload.display_name = pi.fullName;
    if (pi.email !== undefined) columnPayload.email = pi.email;
    if (pi.currentCity !== undefined) columnPayload.current_city = pi.currentCity;
    if (pi.currentJobTitle !== undefined) columnPayload.current_job_title = pi.currentJobTitle;
    if (pi.currentCompany !== undefined) columnPayload.current_company = pi.currentCompany;
    if (pi.workAuthorization !== undefined) columnPayload.work_authorisation = pi.workAuthorization;
    // No dedicated column for phone — lands in the jsonb blob.
    if (pi.phone !== undefined) {
      jsonbPatch.personalInformation = { ...(jsonbPatch.personalInformation ?? {}), phone: pi.phone };
    }
  }

  // ── Skills (dedicated column, direct — not duplicated in jsonb) ────────
  if (sections[PROFILE_SECTIONS.SKILLS] !== undefined) {
    columnPayload.skills = sections[PROFILE_SECTIONS.SKILLS];
  }

  // ── Experience (dedicated column, direct) ───────────────────────────────
  if (sections[PROFILE_SECTIONS.EXPERIENCE] !== undefined) {
    columnPayload.experience = sections[PROFILE_SECTIONS.EXPERIENCE];
  }

  // ── Languages (dedicated column, direct) ────────────────────────────────
  if (sections[PROFILE_SECTIONS.LANGUAGES] !== undefined) {
    columnPayload.languages = sections[PROFILE_SECTIONS.LANGUAGES];
  }

  // ── Career Goals (dedicated columns, direct) ────────────────────────────
  //
  // Career Role Resolution (WP-PRO-10B): the Guided Builder's CareerGoalsForm
  // only captures free-text `targetRole` — there is no role-catalog picker
  // in this repository yet, so `expectedRoleIds` is never sent by that form.
  // Career Report / Career Intelligence require `expected_role_ids`
  // (WP-PRO-10A's verified root cause). Rather than duplicating Career
  // Goals into a second model, this single write path resolves the
  // free-text `targetRole` to the closest canonical role catalog id and
  // persists it into the SAME `expected_role_ids` column, so Career Goals,
  // Professional Profile, and Career Report stay on one source of truth.
  // If an explicit `expectedRoleIds` is provided (e.g. a future role
  // picker, or the existing `saveCareerIntent` path), it is always
  // authoritative and resolution is skipped.
  const goals = sections[PROFILE_SECTIONS.CAREER_GOALS];
  if (goals) {
    if (goals.targetRole !== undefined) columnPayload.target_role = goals.targetRole;

    if (goals.expectedRoleIds !== undefined) {
      columnPayload.expected_role_ids = goals.expectedRoleIds;
    } else if (goals.targetRole) {
      const resolvedRoleIds = await resolveExpectedRoleIdsFromTitle(goals.targetRole);
      if (resolvedRoleIds.length) {
        columnPayload.expected_role_ids = resolvedRoleIds;
      } else {
        logger.warn('[ProfessionalProfileRepository] could not resolve targetRole to a catalog role id', {
          userId,
          targetRole: goals.targetRole,
          source: opts.source ?? 'unknown',
        });
      }
    }
  }

  // ── Employment Preferences (dedicated columns, direct) ──────────────────
  const prefs = sections[PROFILE_SECTIONS.EMPLOYMENT_PREFERENCES];
  if (prefs) {
    if (prefs.workMode !== undefined) columnPayload.work_mode = prefs.workMode;
    if (prefs.preferredWorkLocation !== undefined) columnPayload.preferred_work_location = prefs.preferredWorkLocation;
    if (prefs.expectedSalaryLpa !== undefined) columnPayload.expected_salary_lpa = prefs.expectedSalaryLpa;
    if (prefs.jobSearchTimeline !== undefined) columnPayload.job_search_timeline = prefs.jobSearchTimeline;
  }

  // ── Resume Metadata (resumeId → dedicated columns; rest → jsonb) ───────
  const resumeMeta = sections[PROFILE_SECTIONS.RESUME_METADATA];
  if (resumeMeta) {
    if (resumeMeta.resumeId !== undefined) {
      columnPayload.latest_resume_id = resumeMeta.resumeId;
      columnPayload.resume_uploaded = true;
    }
    const jsonbResumeMeta = {};
    for (const f of ['sourceFileRef', 'parsingConfidence', 'completenessScore', 'parserVersion', 'parsedAt']) {
      if (resumeMeta[f] !== undefined) jsonbResumeMeta[f] = resumeMeta[f];
    }
    if (Object.keys(jsonbResumeMeta).length) {
      jsonbPatch.resumeMetadata = { ...(jsonbPatch.resumeMetadata ?? {}), ...jsonbResumeMeta };
    }
  }

  // ── Education / Projects / Certifications (jsonb-only sections) ────────
  for (const section of JSONB_ONLY_SECTIONS) {
    if (sections[section] !== undefined) {
      jsonbPatch[section] = sections[section];
    }
  }

  // ── Completion Metadata (acquisition provenance only — NOT the
  // authoritative completion flags, which stay owned by
  // onboarding.helpers.js) ────────────────────────────────────────────────
  const completion = sections[PROFILE_SECTIONS.COMPLETION_METADATA];
  if (completion) {
    jsonbPatch.completionMetadata = { ...(jsonbPatch.completionMetadata ?? {}), ...completion };
  }

  // ── Merge jsonb patch into the existing professional_profile blob ──────
  if (Object.keys(jsonbPatch).length > 0) {
    const existing = await readRow(userId);
    const existingBlob = (existing && typeof existing.professional_profile === 'object' && existing.professional_profile) || {};

    const mergedBlob = { ...existingBlob };
    for (const [key, value] of Object.entries(jsonbPatch)) {
      if (Array.isArray(value)) {
        mergedBlob[key] = value; // repeatable sections: wholesale replace
      } else {
        mergedBlob[key] = { ...(existingBlob[key] ?? {}), ...value };
      }
    }

    columnPayload.professional_profile = mergedBlob;
  }

  await authoritativeUpsert({
    table: TABLE_PROFILES,
    payload: columnPayload,
    conflictKey: 'id',
  });

  logger.info('[ProfessionalProfileRepository] Professional Profile sections written', {
    userId,
    source: opts.source ?? 'unknown',
    sections: Object.keys(sections),
  });

  return { written: true, columnPayload, jsonbPatch };
}

/**
 * Read the composed canonical Professional Profile for a user, assembling
 * dedicated columns + the professional_profile jsonb blob into the shape
 * defined by professionalProfile.schema.js. Used by future Guided Builder
 * pre-fill and any consumer that wants the full canonical object rather
 * than reading individual columns itself.
 *
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getProfessionalProfile(userId) {
  const { emptyProfessionalProfile } = require('./professionalProfile.schema');
  if (!userId) return null;

  const row = await readRow(userId);
  if (!row) return null;

  const blob = (row.professional_profile && typeof row.professional_profile === 'object') ? row.professional_profile : {};
  const profile = emptyProfessionalProfile(userId);

  profile.personalInformation = {
    ...profile.personalInformation,
    fullName:          row.display_name ?? null,
    email:             row.email ?? null,
    phone:             blob.personalInformation?.phone ?? null,
    currentCity:       row.current_city ?? null,
    currentJobTitle:   row.current_job_title ?? null,
    currentCompany:    row.current_company ?? null,
    workAuthorization: row.work_authorisation ?? null,
  };

  profile.education = Array.isArray(blob.education) ? blob.education : [];
  profile.experience = Array.isArray(row.experience) ? row.experience : [];
  profile.skills = Array.isArray(row.skills) ? row.skills : [];
  profile.projects = Array.isArray(blob.projects) ? blob.projects : [];
  profile.certifications = Array.isArray(blob.certifications) ? blob.certifications : [];
  profile.languages = Array.isArray(row.languages) ? row.languages : [];

  profile.careerGoals = {
    expectedRoleIds: Array.isArray(row.expected_role_ids) ? row.expected_role_ids : [],
    targetRole:      row.target_role ?? null,
  };

  profile.employmentPreferences = {
    workMode:              row.work_mode ?? null,
    preferredWorkLocation: row.preferred_work_location ?? null,
    expectedSalaryLpa:     row.expected_salary_lpa ?? null,
    jobSearchTimeline:     row.job_search_timeline ?? null,
  };

  profile.resumeMetadata = {
    resumeId:          row.latest_resume_id ?? row.resume_id ?? null,
    sourceFileRef:      blob.resumeMetadata?.sourceFileRef ?? null,
    parsingConfidence: blob.resumeMetadata?.parsingConfidence ?? null,
    completenessScore: blob.resumeMetadata?.completenessScore ?? null,
    parserVersion:     blob.resumeMetadata?.parserVersion ?? null,
    parsedAt:          blob.resumeMetadata?.parsedAt ?? null,
  };

  // Read-only mirror — this repository never writes this section (boundary rule).
  profile.careerIntelligenceMetadata = {
    ...profile.careerIntelligenceMetadata,
    ...(blob.careerIntelligenceMetadata ?? {}),
  };

  profile.completionMetadata = {
    ...profile.completionMetadata,
    ...(blob.completionMetadata ?? {}),
  };

  return profile;
}

module.exports = {
  saveProfessionalProfileSections,
  getProfessionalProfile,
};