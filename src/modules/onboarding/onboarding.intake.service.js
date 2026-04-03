'use strict';

/**
 * src/modules/onboarding/onboarding.intake.service.js
 * Production-safe intake workflow service
 */

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const {
  stripHtml,
  validateExperienceDates,
  computeExperienceMonths,
  emitOnboardingEvent,
  mergeStepHistory,
  persistCompletionIfReady,
  triggerProvisionalChi,
} = require('./onboarding.helpers');

const TABLE_PROGRESS = 'onboarding_progress';
const TABLE_USERS = 'users';
const TABLE_PROFILES = 'user_profiles';

function nowISO() {
  return new Date().toISOString();
}

async function safeUpsert(table, payload) {
  const { error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: 'id' });

  if (error) {
    logger.error(`[OnboardingIntake] ${table}.upsert failed`, {
      table,
      error: error.message,
      payloadKeys: Object.keys(payload || {}),
    });
    throw error;
  }
}

async function safeRead(table, userId, columns = '*') {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.error(`[OnboardingIntake] ${table}.read failed`, {
      table,
      userId,
      error: error.message,
    });
    throw error;
  }

  return data || {};
}

// ─────────────────────────────────────────────────────────────
// CONSENT
// ─────────────────────────────────────────────────────────────
async function saveConsent(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  const { consentVersion } = payload || {};
  if (!consentVersion) {
    throw new AppError('consentVersion required', 400);
  }

  const existing = await safeRead(TABLE_PROGRESS, userId, 'consent_version');

  if (existing?.consent_version === consentVersion) {
    return { userId, alreadyRecorded: true };
  }

  const now = nowISO();
  const stepHistory = await mergeStepHistory(userId, 'consent_saved');

  await Promise.all([
    safeUpsert(TABLE_USERS, {
      id: userId,
      consent_version: consentVersion,
      consent_granted_at: now,
      updated_at: now,
    }),

    safeUpsert(TABLE_PROFILES, {
      id: userId,
      consent_version: consentVersion,
      consent_granted_at: now,
      updated_at: now,
    }),

    safeUpsert(TABLE_PROGRESS, {
      id: userId,
      step: 'consent_saved',
      consent_version: consentVersion,
      consent_granted_at: now,
      step_history: stepHistory,
      updated_at: now,
    }),
  ]);

  emitOnboardingEvent(userId, 'onboarding_step_completed', {
    step: 'consent_saved',
  });

  return { userId, step: 'consent_saved' };
}

// ─────────────────────────────────────────────────────────────
// QUICK START
// ─────────────────────────────────────────────────────────────
async function saveQuickStart(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  const {
    jobTitle,
    company,
    startDate,
    skills = [],
  } = payload || {};

  if (!jobTitle || !company || !startDate) {
    throw new AppError('Missing required fields', 400);
  }

  const now = nowISO();

  const experience = [{
    job_title: stripHtml(jobTitle),
    company: stripHtml(company),
    start_date: startDate,
  }];

  const stepHistory = await mergeStepHistory(userId, 'quick_start_saved');

  await Promise.all([
    safeUpsert(TABLE_PROGRESS, {
      id: userId,
      step: 'quick_start_saved',
      experience,
      skills,
      step_history: stepHistory,
      updated_at: now,
    }),

    safeUpsert(TABLE_PROFILES, {
      id: userId,
      skills,
      updated_at: now,
    }),
  ]);

  triggerProvisionalChi(userId, {}, {}, null, 'free');

  return { userId, step: 'quick_start_saved' };
}

// ─────────────────────────────────────────────────────────────
// EDUCATION + EXPERIENCE
// ─────────────────────────────────────────────────────────────
async function saveEducationAndExperience(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  const {
    education = [],
    experience = [],
    skills = [],
  } = payload || {};

  if (!education.length && !experience.length) {
    throw new AppError('At least one entry required', 400);
  }

  validateExperienceDates(experience);

  const now = nowISO();
  const totalExperienceMonths = computeExperienceMonths(experience);
  const stepHistory = await mergeStepHistory(
    userId,
    'education_experience_saved'
  );

  await Promise.all([
    safeUpsert(TABLE_PROGRESS, {
      id: userId,
      step: 'education_experience_saved',
      education,
      experience,
      skills,
      total_experience_months: totalExperienceMonths,
      step_history: stepHistory,
      updated_at: now,
    }),

    safeUpsert(TABLE_PROFILES, {
      id: userId,
      skills,
      updated_at: now,
    }),
  ]);

  const [progress, profile] = await Promise.all([
    safeRead(TABLE_PROGRESS, userId),
    safeRead(TABLE_PROFILES, userId),
  ]);

  await persistCompletionIfReady(userId, progress, profile);

  return { userId, step: 'education_experience_saved' };
}

// ─────────────────────────────────────────────────────────────
// DRAFT
// ─────────────────────────────────────────────────────────────
async function saveDraft(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  const now = nowISO();
  const stepHistory = await mergeStepHistory(userId, 'draft_saved');

  await safeUpsert(TABLE_PROGRESS, {
    id: userId,
    step: 'draft',
    draft: payload,
    step_history: stepHistory,
    updated_at: now,
  });

  return { userId, step: 'draft' };
}

async function getDraft(userId) {
  if (!userId) throw new AppError('userId required', 400);

  const data = await safeRead(TABLE_PROGRESS, userId, 'draft');

  return {
    userId,
    draft: data?.draft || null,
  };
}

// ─────────────────────────────────────────────────────────────
// PERSONAL DETAILS
// ─────────────────────────────────────────────────────────────
async function savePersonalDetails(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  const { fullName, email } = payload || {};
  if (!fullName || !email) {
    throw new AppError('Missing required fields', 400);
  }

  const now = nowISO();
  const stepHistory = await mergeStepHistory(
    userId,
    'personal_details_saved'
  );

  await safeUpsert(TABLE_PROGRESS, {
    id: userId,
    step: 'personal_details_saved',
    personal_details: payload,
    step_history: stepHistory,
    updated_at: now,
  });

  return { userId, step: 'personal_details_saved' };
}

// ─────────────────────────────────────────────────────────────
// CAREER INTENT
// ─────────────────────────────────────────────────────────────
async function saveCareerIntent(userId, payload) {
  if (!userId) throw new AppError('userId required', 400);

  if (!payload?.expectedRoleIds?.length) {
    throw new AppError('expectedRoleIds required', 400);
  }

  const now = nowISO();
  const stepHistory = await mergeStepHistory(
    userId,
    'career_intent_saved'
  );

  await Promise.all([
    safeUpsert(TABLE_PROFILES, {
      id: userId,
      expected_role_ids: payload.expectedRoleIds,
      updated_at: now,
    }),

    safeUpsert(TABLE_PROGRESS, {
      id: userId,
      step: 'career_intent_saved',
      step_history: stepHistory,
      updated_at: now,
    }),
  ]);

  return { userId, step: 'career_intent_saved' };
}

module.exports = {
  saveConsent,
  saveQuickStart,
  saveEducationAndExperience,
  saveDraft,
  getDraft,
  savePersonalDetails,
  saveCareerIntent,
};