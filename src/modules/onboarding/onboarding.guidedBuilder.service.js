'use strict';

/**
 * @file src/modules/onboarding/onboarding.guidedBuilder.service.js
 *
 * WP-PRO-07 — Task 4: Guided Profile Builder backend support.
 *
 * This is NOT the Guided Builder UI (explicitly out of scope for this WP —
 * "Do not implement the full Guided Builder UI in this work package. Only
 * implement backend support."). It is the backend surface a future Guided
 * Builder frontend will call: one function per canonical section, each of
 * which does nothing but (a) validate presence of a userId, (b) route the
 * raw payload through the SAME normalizer functions Resume Upload and the
 * existing onboarding intake flow already use (Task 2's "do not duplicate
 * mapping logic"), and (c) persist via the same
 * professionalProfile.repository.js write path.
 *
 * Per WP-PRO-04 §4, the Guided Builder's per-step target fields are
 * identical to every other acquisition method's — this file is intentionally
 * thin because the actual mapping logic lives entirely in
 * professionalProfile.normalizer.js.
 *
 * A lightweight onboarding_progress marker is also written for each step,
 * matching the step-tracking convention every other acquisition method in
 * this module already follows (mergeStepHistory), so Completion Metadata /
 * funnel analytics have something to observe once a real Guided Builder UI
 * starts calling these functions. This does not touch or redefine the
 * authoritative completion signal owned by
 * onboarding.helpers.js#persistCompletionIfReady (WP-PRO-06A/06B).
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const {
  normalizePersonalInformation,
  normalizeEducation,
  normalizeExperience,
  normalizeSkills,
  normalizeCertifications,
  normalizeProjects,
  normalizeLanguages,
  normalizeCareerGoals,
  normalizeEmploymentPreferences,
  normalizeCompletionProvenance,
} = require('../../domain/professionalProfile/professionalProfile.normalizer');
const {
  saveProfessionalProfileSections,
  getProfessionalProfile,
} = require('../../domain/professionalProfile/professionalProfile.repository');
const { ACQUISITION_METHODS } = require('../../domain/professionalProfile/professionalProfile.schema');

const { mergeStepHistory } = require('./onboarding.helpers');

const TABLE_PROGRESS = 'onboarding_progress';

/**
 * Section → normalizer-function map. Each normalizer takes this step's raw
 * request body (or the relevant field of it) and returns a partial
 * canonical Professional Profile — see professionalProfile.normalizer.js.
 */
const SECTION_NORMALIZERS = Object.freeze({
  personal_details: (payload) => normalizePersonalInformation(payload),
  education:         (payload) => normalizeEducation(payload?.education ?? payload),
  experience:        (payload) => normalizeExperience(payload?.experience ?? payload),
  skills:            (payload) => normalizeSkills(payload?.skills ?? payload),
  certifications:    (payload) => normalizeCertifications(payload?.certifications ?? payload),
  projects:          (payload) => normalizeProjects(payload?.projects ?? payload),
  languages:         (payload) => normalizeLanguages(payload?.languages ?? payload),
  career_goals:      (payload) => normalizeCareerGoals(payload),
  employment_preferences: (payload) => normalizeEmploymentPreferences(payload),
});

const VALID_SECTIONS = Object.freeze(Object.keys(SECTION_NORMALIZERS));

function nowISO() {
  return new Date().toISOString();
}

/**
 * Save one Guided Builder step/section for a user.
 *
 * @param {string} userId
 * @param {string} section - one of VALID_SECTIONS
 * @param {object} payload - raw section payload from the (future) Guided Builder UI
 * @returns {Promise<{userId: string, section: string, step: string}>}
 */
async function saveGuidedSection(userId, section, payload) {
  if (!userId) {
    throw new AppError('userId required', 400, { userId }, ErrorCodes.VALIDATION_ERROR);
  }
  if (!VALID_SECTIONS.includes(section)) {
    throw new AppError(
      `Unknown Guided Builder section "${section}"`,
      400,
      { section, validSections: VALID_SECTIONS },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const normalize = SECTION_NORMALIZERS[section];
  const partialProfile = {
    ...normalize(payload),
    ...normalizeCompletionProvenance(ACQUISITION_METHODS.GUIDED_BUILDER, `guided_${section}_saved`),
  };

  await saveProfessionalProfileSections(userId, partialProfile, {
    source: ACQUISITION_METHODS.GUIDED_BUILDER,
  });

  // Lightweight step marker — appends to the existing step_history log only.
  // Deliberately does NOT overwrite onboarding_progress.step: that column is
  // the shared "current step" pointer other tracks (A / A-Upload / B) use to
  // resume onboarding, and Guided Builder is a distinct, parallel track —
  // stomping on it would be exactly the kind of cross-track interference
  // this WP must not introduce. No new column is added (no migration).
  const step = `guided_${section}_saved`;
  const step_history = await mergeStepHistory(userId, step);

  const { error } = await supabase
    .from(TABLE_PROGRESS)
    .upsert({
      id:           userId,
      user_id:      userId,
      step_history,
      updated_at:   nowISO(),
    }, { onConflict: 'id' });

  if (error) {
    // Non-fatal: the canonical Professional Profile write above already
    // succeeded, which is this function's actual contract. The progress
    // marker is best-effort observability, not a source of truth.
    logger.warn('[GuidedBuilder] step marker write failed (non-fatal)', {
      userId,
      section,
      error: error.message,
    });
  }

  return { userId, section, step };
}

/**
 * Fetch the current canonical Professional Profile — used by a future
 * Guided Builder UI to pre-fill fields with whatever another acquisition
 * method (e.g. a prior Resume Upload) already populated, satisfying
 * WP-PRO-04's convergence principle (every method reads/writes the same
 * profile, none has its own parallel storage shape).
 *
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getGuidedBuilderPrefill(userId) {
  if (!userId) {
    throw new AppError('userId required', 400, { userId }, ErrorCodes.VALIDATION_ERROR);
  }
  return getProfessionalProfile(userId);
}

module.exports = Object.freeze({
  VALID_SECTIONS,
  saveGuidedSection,
  getGuidedBuilderPrefill,
});
