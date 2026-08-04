'use strict';

/**
 * @file src/domain/professionalProfile/professionalProfile.normalizer.js
 *
 * WP-PRO-07 — Professional Profile Normalization Engine
 *
 * This module is the SINGLE PRODUCER of canonical Professional Profile
 * section shapes (WP-PRO-04 §2). Every onboarding acquisition method
 * (Resume Upload, Guided Builder, existing Professional onboarding intake)
 * must route its raw, acquisition-specific payload through these functions
 * rather than mapping fields to the canonical shape itself — this is what
 * "single producer" means in practice (Task 1 / Task 2).
 *
 * Design:
 *  - Each `normalizeX()` function takes acquisition-specific input and
 *    returns ONLY the canonical section(s) it can populate. Fields the
 *    input does not provide are left absent (`undefined`), never guessed
 *    or defaulted to a fabricated value — this is what keeps missing
 *    information "incomplete rather than invented" (Task 3).
 *  - `normalizeResumeUpload()` composes the per-section normalizers to
 *    build a full partial-profile object from a HireRiseResume (the
 *    existing resume-parsing pipeline's output shape — see
 *    services/resumeParser/resume.normalizer.js). It does NOT re-implement
 *    resume parsing/classification; it re-shapes already-parsed data into
 *    the canonical Professional Profile sections.
 *  - `mergeProfileSections()` merges a partial profile into a base profile.
 *    Repeatable sections (education, experience, skills, projects,
 *    certifications, languages) are replaced wholesale when supplied —
 *    this matches how every existing acquisition method already behaves
 *    (each save of a repeatable section sends the complete current list,
 *    not a delta), so this preserves existing semantics rather than
 *    introducing new merge behaviour.
 *  - Career Intelligence Metadata is never produced here — see
 *    professionalProfile.schema.js's boundary rule. No function in this
 *    file accepts input that could populate that section.
 *
 * This is a PURE function module — no I/O, no DB, no HTTP.
 */

const { PROFILE_SECTIONS, ACQUISITION_METHODS } = require('./professionalProfile.schema');

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function str(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-section normalizers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize Personal Information from any acquisition-specific shape.
 * Accepts either guided-builder/intake style flat fields (fullName, email,
 * ...) or a HireRiseResume `core` object (fullName, email, phone, location,
 * title) via the `fromResumeCore` flag.
 *
 * @param {object} input
 * @returns {object} Partial profile: { personalInformation }
 */
function normalizePersonalInformation(input = {}) {
  const pi = compact({
    fullName:          str(input.fullName ?? input.full_name),
    email:             str(input.email),
    phone:             str(input.phone),
    currentCity:       str(input.currentCity ?? input.current_city ?? input.city),
    currentJobTitle:   str(input.currentJobTitle ?? input.current_job_title ?? input.jobTitle ?? input.title),
    currentCompany:    str(input.currentCompany ?? input.current_company ?? input.company),
    workAuthorization: str(input.workAuthorization ?? input.work_authorisation),
  });

  if (Object.keys(pi).length === 0) return {};
  return { [PROFILE_SECTIONS.PERSONAL_INFORMATION]: pi };
}

/**
 * Normalize Education entries. Accepts either the guided-builder/intake
 * shape (degree, institution, ...) or HireRiseResume education entries
 * (degree, institution, startYear, endYear) — the two are already
 * compatible field names, so this is a light validation/shape pass, not a
 * remapping.
 *
 * @param {Array<object>} entries
 * @returns {object} Partial profile: { education } (only if entries given)
 */
function normalizeEducation(entries) {
  if (!Array.isArray(entries)) return {};

  const education = entries
    .filter(e => e && typeof e === 'object')
    .map(e => compact({
      degree:      str(e.degree ?? e.qualification),
      institution: str(e.institution ?? e.school),
      fieldOfStudy: str(e.fieldOfStudy ?? e.field_of_study ?? e.field),
      startYear:   e.startYear ?? e.start_year ?? null,
      endYear:     e.endYear ?? e.end_year ?? null,
      grade:       str(e.grade),
    }));

  return { [PROFILE_SECTIONS.EDUCATION]: education };
}

/**
 * Normalize Experience entries. Accepts guided-builder/intake shape
 * (job_title/title, company, start_date/startDate, ...) or HireRiseResume
 * experience entries (role, company, startDate, endDate, type).
 *
 * @param {Array<object>} entries
 * @returns {object} Partial profile: { experience }
 */
function normalizeExperience(entries) {
  if (!Array.isArray(entries)) return {};

  const experience = entries
    .filter(e => e && typeof e === 'object')
    .map(e => compact({
      title:       str(e.role ?? e.job_title ?? e.title),
      company:     str(e.company),
      startDate:   str(e.startDate ?? e.start_date),
      endDate:     str(e.endDate ?? e.end_date),
      current:     typeof e.current === 'boolean' ? e.current : undefined,
      description: str(e.description),
      type:        str(e.type), // 'job' | 'internship' | 'project' — set by resume pipeline, absent for manual entry
    }));

  return { [PROFILE_SECTIONS.EXPERIENCE]: experience };
}

/**
 * Normalize Skills. Accepts a list of strings or { name } objects, from
 * either guided-builder input or HireRiseResume skills.
 *
 * @param {Array<string|object>} entries
 * @returns {object} Partial profile: { skills }
 */
function normalizeSkills(entries) {
  if (!Array.isArray(entries)) return {};

  const skills = entries
    .map(s => (typeof s === 'string' ? s : s?.name))
    .map(name => str(name))
    .filter(Boolean)
    .map(name => ({ name, source: 'declared' }));

  return { [PROFILE_SECTIONS.SKILLS]: skills };
}

/**
 * Normalize Skills that were AI-extracted/inferred rather than user-declared
 * (WP-PRO-04 §3: "Each skill entry should carry a source tag"). Reserved for
 * future resume-intelligence-driven skill inference; not currently invoked
 * by any acquisition method in this WP, since today's resume parser only
 * produces declared (extracted-from-text) skills, which are still
 * represented with source: 'declared' via normalizeSkills above.
 *
 * @param {Array<string|object>} entries
 * @returns {object} Partial profile: { skills }
 */
function normalizeInferredSkills(entries) {
  if (!Array.isArray(entries)) return {};
  const skills = entries
    .map(s => (typeof s === 'string' ? s : s?.name))
    .map(name => str(name))
    .filter(Boolean)
    .map(name => ({ name, source: 'extracted' }));
  return { [PROFILE_SECTIONS.SKILLS]: skills };
}

/**
 * Normalize Certifications. Accepts strings or { name, issuer, year } objects.
 *
 * @param {Array<string|object>} entries
 * @returns {object} Partial profile: { certifications }
 */
function normalizeCertifications(entries) {
  if (!Array.isArray(entries)) return {};

  const certifications = entries
    .map(c => (typeof c === 'string' ? { name: c } : c))
    .filter(c => c && str(c.name))
    .map(c => compact({
      name:   str(c.name),
      issuer: str(c.issuer),
      year:   c.year ?? null,
    }));

  return { [PROFILE_SECTIONS.CERTIFICATIONS]: certifications };
}

/**
 * Normalize Projects. Accepts strings or { name, description, url } objects.
 *
 * @param {Array<string|object>} entries
 * @returns {object} Partial profile: { projects }
 */
function normalizeProjects(entries) {
  if (!Array.isArray(entries)) return {};

  const projects = entries
    .map(p => (typeof p === 'string' ? { name: p } : p))
    .filter(p => p && str(p.name))
    .map(p => compact({
      name:        str(p.name),
      description: str(p.description),
      url:         str(p.url),
    }));

  return { [PROFILE_SECTIONS.PROJECTS]: projects };
}

/**
 * Normalize Languages. Accepts strings or { name, proficiency } objects.
 *
 * @param {Array<string|object>} entries
 * @returns {object} Partial profile: { languages }
 */
function normalizeLanguages(entries) {
  if (!Array.isArray(entries)) return {};

  const languages = entries
    .map(l => (typeof l === 'string' ? { name: l } : l))
    .filter(l => l && str(l.name))
    .map(l => compact({
      name:        str(l.name),
      proficiency: str(l.proficiency),
    }));

  return { [PROFILE_SECTIONS.LANGUAGES]: languages };
}

/**
 * Normalize Career Goals.
 *
 * WP-PRO-04 §1/§3 flags three fragmented storage locations for this data
 * (user_profiles.expected_role_ids, users.career_goal,
 * user_profiles.data.career_goals) and states the canonical model "must
 * designate exactly one as authoritative." Consolidating those three
 * pre-existing locations is a data-migration decision out of this WP's
 * scope (per this WP's "do not redesign the Professional Profile domain
 * model" constraint — WP-PRO-04 leaves the exact resolution to a future
 * WP-PRO-05-class decision). This normalizer designates
 * `expected_role_ids` as the canonical Career Goals target for new writes
 * going through this engine, since it is the only one of the three already
 * written by the live, canonical onboarding path (Implementation A, per
 * WP-PRO-05B) and is a dedicated (non-jsonb-blob) column. The other two
 * legacy locations are left untouched by this engine.
 *
 * @param {object} input - { expectedRoleIds?: string[], targetRole?: string }
 * @returns {object} Partial profile: { careerGoals }
 */
function normalizeCareerGoals(input = {}) {
  const goals = compact({
    expectedRoleIds: Array.isArray(input.expectedRoleIds) ? input.expectedRoleIds : undefined,
    targetRole:      str(input.targetRole ?? input.target_role),
  });

  if (Object.keys(goals).length === 0) return {};
  return { [PROFILE_SECTIONS.CAREER_GOALS]: goals };
}

/**
 * Normalize Employment Preferences.
 *
 * @param {object} input
 * @returns {object} Partial profile: { employmentPreferences }
 */
function normalizeEmploymentPreferences(input = {}) {
  const prefs = compact({
    workMode:              str(input.workMode ?? input.work_mode),
    preferredWorkLocation: str(input.preferredWorkLocation ?? input.preferred_work_location),
    expectedSalaryLpa:     input.expectedSalaryLpa ?? input.expected_salary_lpa ?? undefined,
    jobSearchTimeline:     str(input.jobSearchTimeline ?? input.job_search_timeline),
  });

  if (Object.keys(prefs).length === 0) return {};
  return { [PROFILE_SECTIONS.EMPLOYMENT_PREFERENCES]: prefs };
}

/**
 * Normalize Resume Metadata. Only populated by Upload Resume (WP-PRO-04 §3:
 * "Optional (only present if Upload Resume was used)").
 *
 * @param {object} input - { resumeId, parsingConfidence, completenessScore, parserVersion, parsedAt }
 * @returns {object} Partial profile: { resumeMetadata }
 */
function normalizeResumeMetadata(input = {}) {
  const meta = compact({
    resumeId:          str(input.resumeId),
    sourceFileRef:     str(input.sourceFileRef ?? input.fileUrl),
    parsingConfidence: typeof input.parsingConfidence === 'number' ? input.parsingConfidence : undefined,
    completenessScore: typeof input.completenessScore === 'number' ? input.completenessScore : undefined,
    parserVersion:     str(input.parserVersion),
    parsedAt:          str(input.parsedAt),
  });

  if (Object.keys(meta).length === 0) return {};
  return { [PROFILE_SECTIONS.RESUME_METADATA]: meta };
}

/**
 * Normalize Completion Metadata's acquisition-provenance fields.
 * NOTE: this only ever records which acquisition method populated the
 * profile at write time — the authoritative onboarding-completion signal
 * itself (onboarding_completed / professional_onboarding_complete) remains
 * owned exclusively by onboarding.helpers.js#persistCompletionIfReady
 * (WP-PRO-06A/06B) and is NOT duplicated here.
 *
 * @param {string} acquisitionMethod - one of ACQUISITION_METHODS
 * @param {string} step
 * @returns {object} Partial profile: { completionMetadata }
 */
function normalizeCompletionProvenance(acquisitionMethod, step) {
  if (!acquisitionMethod) return {};
  return {
    [PROFILE_SECTIONS.COMPLETION_METADATA]: compact({
      acquisitionMethod,
      lastStep: str(step),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume Upload composite normalizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a full partial Professional Profile from a HireRiseResume (the
 * output of services/resumeParser/resume.normalizer.js's
 * normalizeFromOnboardingShape / normalizeFromParsed / normalizeAny).
 *
 * This function performs NO parsing itself — it re-shapes already-parsed,
 * already-classified resume data into the canonical section shapes. Fields
 * the resume parser did not find (e.g. an empty experience[] because the
 * user's resume genuinely has none yet) are passed through as empty
 * arrays/omitted fields rather than fabricated — satisfying Task 3
 * ("missing information should remain incomplete rather than inventing
 * values").
 *
 * @param {object} structuredResume - HireRiseResume (see hirerise-resume.schema.js)
 * @param {object} [meta] - { resumeId, fileUrl, parserVersion }
 * @returns {object} Partial canonical Professional Profile
 */
function normalizeResumeUpload(structuredResume, meta = {}) {
  if (!structuredResume || typeof structuredResume !== 'object') return {};

  const core = structuredResume.core ?? {};
  const certsSection = (structuredResume.additionalSections ?? [])
    .find(s => s.title === 'Certifications')?.items ?? [];
  const projectsSection = (structuredResume.additionalSections ?? [])
    .find(s => s.title === 'Projects')?.items ?? [];

  const partial = {};

  // WP-PRO-09N FIX: `core` (HireRiseResume.core) has no company field at
  // all, so currentCompany was never populated here — meaning a stale
  // currentCompany value from a prior upload/manual edit could never be
  // overwritten by mergeProfileSections' shallow object-section merge
  // (see below), and would silently persist forever ("Master Handyman
  // Services" surviving a resume upload that never mentions it).
  // The most recent job's employer (experience[0].company) is the correct,
  // resume-derived source of truth for "current company".
  const mostRecentExperience = (structuredResume.experience ?? [])[0];

  Object.assign(partial, normalizePersonalInformation({
    fullName: core.fullName,
    email:    core.email,
    phone:    core.phone,
    city:     core.location, // resume core.location is a free-text "City, Country" string
    title:    core.title,
    company:  mostRecentExperience?.company,
  }));

  Object.assign(partial, normalizeEducation(structuredResume.education));
  Object.assign(partial, normalizeExperience(structuredResume.experience));
  Object.assign(partial, normalizeSkills(structuredResume.skills));
  Object.assign(partial, normalizeCertifications(certsSection));
  Object.assign(partial, normalizeProjects(projectsSection));

  Object.assign(partial, normalizeResumeMetadata({
    resumeId:          meta.resumeId ?? structuredResume.resumeId,
    sourceFileRef:     meta.fileUrl,
    parsingConfidence: structuredResume.metadata?.parsingConfidence,
    completenessScore: structuredResume.metadata?.completenessScore,
    parserVersion:     meta.parserVersion ?? structuredResume.metadata?.schemaVersion,
    parsedAt:          structuredResume.metadata?.parsedAt,
  }));

  Object.assign(partial, normalizeCompletionProvenance(
    ACQUISITION_METHODS.RESUME_UPLOAD,
    'cv_uploaded'
  ));

  return partial;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge a partial canonical Professional Profile into a base profile.
 * Repeatable sections (education, experience, skills, projects,
 * certifications, languages) are replaced wholesale when the partial
 * supplies them, matching existing acquisition-method semantics (each save
 * already sends the complete current list). Object sections
 * (personalInformation, careerGoals, employmentPreferences, resumeMetadata,
 * completionMetadata) are shallow-merged field by field so that supplying
 * one field doesn't erase previously-known fields in the same section.
 *
 * @param {object} base
 * @param {object} partial
 * @returns {object} merged profile
 */
function mergeProfileSections(base, partial) {
  const merged = { ...base };

  for (const [section, value] of Object.entries(partial)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      merged[section] = value; // repeatable sections: wholesale replace
    } else if (value && typeof value === 'object') {
      merged[section] = { ...(base[section] ?? {}), ...value }; // object sections: shallow merge
    } else {
      merged[section] = value;
    }
  }

  return merged;
}

module.exports = Object.freeze({
  normalizePersonalInformation,
  normalizeEducation,
  normalizeExperience,
  normalizeSkills,
  normalizeInferredSkills,
  normalizeCertifications,
  normalizeProjects,
  normalizeLanguages,
  normalizeCareerGoals,
  normalizeEmploymentPreferences,
  normalizeResumeMetadata,
  normalizeCompletionProvenance,
  normalizeResumeUpload,
  mergeProfileSections,
});