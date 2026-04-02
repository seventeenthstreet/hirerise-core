'use strict';

/**
 * onboarding.intake.service.js — FULLY FIXED (Production Safe)
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const {
  stripHtml,
  validateUrl,
  validateYearOfGraduation,
  validateAndSanitiseResponsibilities,
  validateAchievements,
  validateExperienceDates,
  computeExperienceMonths,
  emitOnboardingEvent,
  mergeStepHistory,
  persistCompletionIfReady,
  triggerProvisionalChi,
  VALID_SENIORITY,
  VALID_EXPERIENCE_TYPES
} = require('./onboarding.helpers');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

async function safeUpsert(table, payload) {
  const { error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: 'id' });

  if (error) {
    logger.error(`[DB] ${table}.upsert failed`, error.message);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────
// CONSENT
// ─────────────────────────────────────────────────────────────

async function saveConsent(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  const { consentVersion } = payload;
  if (!consentVersion) throw new AppError('consentVersion required', 400);

  const now = nowISO();

  const { data: existing } = await supabase
    .from('onboarding_progress')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (existing?.consent_version === consentVersion) {
    return { userId, alreadyRecorded: true };
  }

  const stepHistory = await mergeStepHistory(userId, 'consent_saved');

  await Promise.all([
    safeUpsert('users', {
      id: userId,
      consent_version: consentVersion,
      consent_granted_at: now,
      updated_at: now
    }),

    safeUpsert('user_profiles', {
      id: userId,
      consent_version: consentVersion,
      consent_granted_at: now,
      updated_at: now
    }),

    safeUpsert('onboarding_progress', {
      id: userId,
      step: 'consent_saved',
      consent_version: consentVersion,
      consent_granted_at: now,
      step_history: stepHistory,
      updated_at: now
    })
  ]);

  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'consent_saved' });

  return { userId, step: 'consent_saved' };
}

// ─────────────────────────────────────────────────────────────
// QUICK START
// ─────────────────────────────────────────────────────────────

async function saveQuickStart(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  const { jobTitle, company, startDate, skills = [] } = payload;

  if (!jobTitle || !company || !startDate) {
    throw new AppError('Missing required fields', 400);
  }

  const now = nowISO();

  const experience = [{
    job_title: stripHtml(jobTitle),
    company: stripHtml(company),
    start_date: startDate
  }];

  const stepHistory = await mergeStepHistory(userId, 'quick_start_saved');

  await Promise.all([
    safeUpsert('onboarding_progress', {
      id: userId,
      step: 'quick_start_saved',
      experience,
      skills,
      step_history: stepHistory,
      updated_at: now
    }),

    safeUpsert('user_profiles', {
      id: userId,
      skills,
      updated_at: now
    })
  ]);

  triggerProvisionalChi(userId, {}, {}, null, 'free');

  return { userId, step: 'quick_start_saved' };
}

// ─────────────────────────────────────────────────────────────
// EDUCATION + EXPERIENCE
// ─────────────────────────────────────────────────────────────

async function saveEducationAndExperience(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  const { education = [], experience = [], skills = [] } = payload;

  if (!education.length && !experience.length) {
    throw new AppError('At least one entry required', 400);
  }

  validateExperienceDates(experience);

  const now = nowISO();
  const totalExperienceMonths = computeExperienceMonths(experience);

  const stepHistory = await mergeStepHistory(userId, 'education_experience_saved');

  await safeUpsert('onboarding_progress', {
    id: userId,
    step: 'education_experience_saved',
    education,
    experience,
    skills,
    total_experience_months: totalExperienceMonths,
    step_history: stepHistory,
    updated_at: now
  });

  await safeUpsert('user_profiles', {
    id: userId,
    skills,
    updated_at: now
  });

  const { data: progress } = await supabase
    .from('onboarding_progress')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  await persistCompletionIfReady(userId, progress || {}, profile || {});

  return { userId, step: 'education_experience_saved' };
}

// ─────────────────────────────────────────────────────────────
// DRAFT
// ─────────────────────────────────────────────────────────────

async function saveDraft(userId, payload) {
  const now = nowISO();
  const stepHistory = await mergeStepHistory(userId, 'draft_saved');

  await safeUpsert('onboarding_progress', {
    id: userId,
    step: 'draft',
    draft: payload,
    step_history: stepHistory,
    updated_at: now
  });

  return { userId, step: 'draft' };
}

async function getDraft(userId) {
  const { data } = await supabase
    .from('onboarding_progress')
    .select('draft')
    .eq('id', userId)
    .maybeSingle();

  return { userId, draft: data?.draft || null };
}

// ─────────────────────────────────────────────────────────────
// PERSONAL DETAILS
// ─────────────────────────────────────────────────────────────

async function savePersonalDetails(userId, payload) {
  const { fullName, email } = payload;

  if (!fullName || !email) throw new AppError('Missing required fields', 400);

  const now = nowISO();
  const stepHistory = await mergeStepHistory(userId, 'personal_details_saved');

  await safeUpsert('onboarding_progress', {
    id: userId,
    step: 'personal_details_saved',
    personal_details: payload,
    step_history: stepHistory,
    updated_at: now
  });

  return { userId, step: 'personal_details_saved' };
}

// ─────────────────────────────────────────────────────────────
// CAREER INTENT
// ─────────────────────────────────────────────────────────────

async function saveCareerIntent(userId, payload) {
  if (!payload.expectedRoleIds?.length) {
    throw new AppError('expectedRoleIds required', 400);
  }

  const now = nowISO();
  const stepHistory = await mergeStepHistory(userId, 'career_intent_saved');

  await Promise.all([
    safeUpsert('user_profiles', {
      id: userId,
      expected_role_ids: payload.expectedRoleIds,
      updated_at: now
    }),

    safeUpsert('onboarding_progress', {
      id: userId,
      step: 'career_intent_saved',
      step_history: stepHistory,
      updated_at: now
    })
  ]);

  return { userId, step: 'career_intent_saved' };
}

// ─────────────────────────────────────────────────────────────

module.exports = {
  saveConsent,
  saveQuickStart,
  saveEducationAndExperience,
  saveDraft,
  getDraft,
  savePersonalDetails,
  saveCareerIntent
};
