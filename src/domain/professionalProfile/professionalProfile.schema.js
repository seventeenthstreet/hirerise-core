'use strict';

/**
 * @file src/domain/professionalProfile/professionalProfile.schema.js
 *
 * WP-PRO-07 — Professional Profile Normalization Engine
 *
 * Canonical Professional Profile shape, per the domain model approved in
 * WP-PRO-04 ("Canonical Professional Profile Domain Model"). This file does
 * not decide storage encoding (that is professionalProfile.repository.js's
 * job) — it defines the twelve sections of the profile itself, matching
 * WP-PRO-04 §2/§10 exactly:
 *
 *   1. Personal Information
 *   2. Education
 *   3. Experience
 *   4. Skills
 *   5. Projects
 *   6. Certifications
 *   7. Languages
 *   8. Career Goals
 *   9. Employment Preferences
 *  10. Resume Metadata
 *  11. Career Intelligence Metadata
 *  12. Completion Metadata
 *
 * BOUNDARY RULE (WP-PRO-04 §5): Career Intelligence Metadata must be written
 * only by Career Report / CHI / Resume Intelligence / other Career
 * Intelligence modules — never by an onboarding acquisition method. This
 * engine enforces that boundary at the repository layer (see
 * professionalProfile.repository.js), not just by convention here.
 *
 * This is a PURE data-shape module — no I/O, no DB, no HTTP.
 */

/** @enum {string} Acquisition methods this WP implements normalization for. */
const ACQUISITION_METHODS = Object.freeze({
  RESUME_UPLOAD:        'resume_upload',
  GUIDED_BUILDER:       'guided_builder',
  ONBOARDING_INTAKE:    'onboarding_intake', // existing Professional onboarding flow (education-experience, personal-details, career-intent steps)
  // Recognized but not implemented in this WP — see WP-PRO-07 §7 Remaining Future Work.
  LINKEDIN_IMPORT:      'linkedin_import',
  GITHUB_IMPORT:        'github_import',
  PORTFOLIO_IMPORT:     'portfolio_import',
  ENTERPRISE_HR_IMPORT: 'enterprise_hr_import',
});

/** Canonical section keys, in WP-PRO-04 §2 order. */
const PROFILE_SECTIONS = Object.freeze({
  PERSONAL_INFORMATION:        'personalInformation',
  EDUCATION:                   'education',
  EXPERIENCE:                  'experience',
  SKILLS:                      'skills',
  PROJECTS:                    'projects',
  CERTIFICATIONS:              'certifications',
  LANGUAGES:                   'languages',
  CAREER_GOALS:                'careerGoals',
  EMPLOYMENT_PREFERENCES:      'employmentPreferences',
  RESUME_METADATA:             'resumeMetadata',
  CAREER_INTELLIGENCE_METADATA: 'careerIntelligenceMetadata',
  COMPLETION_METADATA:         'completionMetadata',
});

/**
 * Sections an onboarding acquisition method is permitted to write.
 * Career Intelligence Metadata is deliberately excluded — see boundary rule
 * above. Completion Metadata is writable only via the dedicated completion
 * helper (onboarding.helpers.js persistCompletionIfReady), not via generic
 * section writes, so it is also excluded from acquisition-time writes here.
 */
const ACQUISITION_WRITABLE_SECTIONS = Object.freeze([
  PROFILE_SECTIONS.PERSONAL_INFORMATION,
  PROFILE_SECTIONS.EDUCATION,
  PROFILE_SECTIONS.EXPERIENCE,
  PROFILE_SECTIONS.SKILLS,
  PROFILE_SECTIONS.PROJECTS,
  PROFILE_SECTIONS.CERTIFICATIONS,
  PROFILE_SECTIONS.LANGUAGES,
  PROFILE_SECTIONS.CAREER_GOALS,
  PROFILE_SECTIONS.EMPLOYMENT_PREFERENCES,
  PROFILE_SECTIONS.RESUME_METADATA,
]);

/**
 * Returns an empty canonical Professional Profile.
 * Missing information stays absent/null rather than being invented — callers
 * merge only the sections they actually have data for (see
 * professionalProfile.normalizer.js).
 *
 * @param {string} userId
 * @returns {object} Canonical Professional Profile
 */
function emptyProfessionalProfile(userId) {
  return {
    userId: userId ?? null,

    [PROFILE_SECTIONS.PERSONAL_INFORMATION]: {
      fullName:          null,
      email:             null,
      phone:             null,
      currentCity:       null,
      currentJobTitle:   null,
      currentCompany:    null,
      workAuthorization: null,
    },

    [PROFILE_SECTIONS.EDUCATION]: [],
    [PROFILE_SECTIONS.EXPERIENCE]: [],
    [PROFILE_SECTIONS.SKILLS]: [],
    [PROFILE_SECTIONS.PROJECTS]: [],
    [PROFILE_SECTIONS.CERTIFICATIONS]: [],
    [PROFILE_SECTIONS.LANGUAGES]: [],

    [PROFILE_SECTIONS.CAREER_GOALS]: {
      expectedRoleIds: [],
      targetRole:      null,
    },

    [PROFILE_SECTIONS.EMPLOYMENT_PREFERENCES]: {
      workMode:               null,
      preferredWorkLocation:  null,
      expectedSalaryLpa:      null,
      jobSearchTimeline:      null,
    },

    [PROFILE_SECTIONS.RESUME_METADATA]: {
      resumeId:           null,
      sourceFileRef:       null,
      parsingConfidence:  null,
      completenessScore:  null,
      parserVersion:      null,
      parsedAt:           null,
    },

    // Derived exclusively by Career Intelligence modules. Never populated by
    // an acquisition method — see boundary rule above.
    [PROFILE_SECTIONS.CAREER_INTELLIGENCE_METADATA]: {
      chiScore:             null,
      careerReportRef:      null,
      recommendationState:  null,
    },

    [PROFILE_SECTIONS.COMPLETION_METADATA]: {
      acquisitionMethod: null,
      stepsCompleted:    [],
      completedAt:       null,
    },
  };
}

module.exports = Object.freeze({
  ACQUISITION_METHODS,
  PROFILE_SECTIONS,
  ACQUISITION_WRITABLE_SECTIONS,
  emptyProfessionalProfile,
});
