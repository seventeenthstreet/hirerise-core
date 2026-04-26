'use strict';

/**
 * src/modules/onboarding/onboarding.intake.service.js
 *
 * FIX: Every upsert to onboarding_progress now writes BOTH `id` and `user_id`
 * to the same userId value. Previously only `id` was written, but
 * mergeStepHistory() and persistCompletionIfReady() query by `user_id`,
 * so step history was never found and onboarding completion never triggered.
 *
 * The onboarding_progress table has:
 *   id (PK, text)      — used as the upsert conflict key
 *   user_id (unique)   — used for all SELECT/UPDATE operations and RLS policy
 * Both must be set to the same userId value.
 */

const { supabase }            = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger                  = require('../../utils/logger');

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
const TABLE_USERS    = 'users';
const TABLE_PROFILES = 'user_profiles';

const CONFLICT_KEYS = Object.freeze({
  [TABLE_PROGRESS]: 'id',
  [TABLE_USERS]:    'id',
  [TABLE_PROFILES]: 'id',
});

function requireUserId(userId) {
  if (!userId) {
    throw new AppError('userId required', 400, { userId }, ErrorCodes.VALIDATION_ERROR);
  }
}

function nowISO() {
  return new Date().toISOString();
}

async function safeUpsert(table, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Invalid upsert payload', 400, { table }, ErrorCodes.VALIDATION_ERROR);
  }

  const { error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: CONFLICT_KEYS[table] || 'id' });

  if (error) {
    logger.error('[OnboardingIntake] upsert failed', {
      table,
      error:       error.message,
      payloadKeys: Object.keys(payload),
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
    logger.error('[OnboardingIntake] read failed', { table, userId, error: error.message });
    throw error;
  }

  return data || {};
}

/**
 * Write a step to onboarding_progress.
 * FIX: writes user_id alongside id so subsequent queries by user_id succeed.
 */
async function writeProgress(userId, step, payload = {}) {
  const updated_at   = nowISO();
  const step_history = await mergeStepHistory(userId, step);

  await safeUpsert(TABLE_PROGRESS, {
    id:          userId,   // PK — used for ON CONFLICT
    user_id:     userId,   // ← FIX: must be set; RLS policy and all queries use this column
    step,
    ...payload,
    step_history,
    updated_at,
  });

  return { updated_at, step_history };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveConsent
// ─────────────────────────────────────────────────────────────────────────────

async function saveConsent(userId, payload) {
  requireUserId(userId);

  const { consentGiven, consentVersion } = payload || {};

  if (!consentVersion) {
    throw new AppError('consentVersion required', 400, { payload }, ErrorCodes.VALIDATION_ERROR);
  }

  // Idempotency: skip if already recorded
  const existing = await safeRead(TABLE_PROGRESS, userId, 'consent_version');

  if (existing?.consent_version === consentVersion) {
    return { userId, alreadyRecorded: true };
  }

  const now = nowISO();

  await Promise.all([
    safeUpsert(TABLE_USERS, {
      id:                  userId,
      consent_version:     consentVersion,
      consent_granted_at:  now,
      updated_at:          now,
    }),

    safeUpsert(TABLE_PROFILES, {
      id:                  userId,
      consent_version:     consentVersion,
      consent_granted_at:  now,
      updated_at:          now,
    }),

    writeProgress(userId, 'consent_saved', {
      consent_version:    consentVersion,
      consent_granted_at: now,
    }),
  ]);

  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'consent_saved' });

  return { userId, step: 'consent_saved' };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveQuickStart
// ─────────────────────────────────────────────────────────────────────────────

async function saveQuickStart(userId, payload) {
  requireUserId(userId);

  const { jobTitle, company, startDate, skills = [] } = payload || {};

  if (!jobTitle || !company || !startDate) {
    throw new AppError('Missing required fields', 400, { payload }, ErrorCodes.VALIDATION_ERROR);
  }

  const experience = [{
    job_title:  stripHtml(jobTitle),
    company:    stripHtml(company),
    start_date: startDate,
  }];

  await Promise.all([
    writeProgress(userId, 'quick_start_saved', { experience, skills }),

    safeUpsert(TABLE_PROFILES, {
      id:         userId,
      skills,
      updated_at: nowISO(),
    }),
  ]);

  // Non-blocking CHI trigger
  Promise.resolve()
    .then(() => triggerProvisionalChi(userId, {}, {}, null, 'free'))
    .catch((error) => {
      logger.warn('[OnboardingIntake] Provisional CHI trigger failed', {
        userId,
        error: error.message,
      });
    });

  return { userId, step: 'quick_start_saved' };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveEducationAndExperience
// ─────────────────────────────────────────────────────────────────────────────

async function saveEducationAndExperience(userId, payload) {
  requireUserId(userId);

  const { education = [], experience = [], skills = [] } = payload || {};

  if (!education.length && !experience.length) {
    throw new AppError('At least one entry required', 400, { payload }, ErrorCodes.VALIDATION_ERROR);
  }

  // Validate experience date ranges if helper exists
  if (typeof validateExperienceDates === 'function') {
    validateExperienceDates(experience);
  }

  const totalExperienceMonths =
    typeof computeExperienceMonths === 'function'
      ? computeExperienceMonths(experience)
      : 0;

  await Promise.all([
    writeProgress(userId, 'education_experience_saved', {
      education,
      experience,
      skills,
      total_experience_months: totalExperienceMonths,
    }),

    safeUpsert(TABLE_PROFILES, {
      id:         userId,
      skills,
      updated_at: nowISO(),
    }),
  ]);

  const [progress, profile] = await Promise.all([
    safeRead(TABLE_PROGRESS, userId),
    safeRead(TABLE_PROFILES, userId),
  ]);

  await persistCompletionIfReady(userId, progress, profile);

  return { userId, step: 'education_experience_saved' };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveDraft / getDraft
// ─────────────────────────────────────────────────────────────────────────────

async function saveDraft(userId, payload) {
  requireUserId(userId);

  await writeProgress(userId, 'draft', { draft: payload });

  return { userId, step: 'draft' };
}

async function getDraft(userId) {
  requireUserId(userId);

  const data = await safeRead(TABLE_PROGRESS, userId, 'draft');

  return { userId, draft: data?.draft || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// savePersonalDetails
// ─────────────────────────────────────────────────────────────────────────────

async function savePersonalDetails(userId, payload) {
  requireUserId(userId);

  const { fullName, email } = payload || {};
  if (!fullName || !email) {
    throw new AppError('Missing required fields', 400, { payload }, ErrorCodes.VALIDATION_ERROR);
  }

  await writeProgress(userId, 'personal_details_saved', { personal_details: payload });

  return { userId, step: 'personal_details_saved' };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveCareerIntent
// ─────────────────────────────────────────────────────────────────────────────

async function saveCareerIntent(userId, payload) {
  requireUserId(userId);

  if (!payload?.expectedRoleIds?.length) {
    throw new AppError('expectedRoleIds required', 400, { payload }, ErrorCodes.VALIDATION_ERROR);
  }

  await Promise.all([
    safeUpsert(TABLE_PROFILES, {
      id:                userId,
      expected_role_ids: payload.expectedRoleIds,
      updated_at:        nowISO(),
    }),

    writeProgress(userId, 'career_intent_saved'),
  ]);

  return { userId, step: 'career_intent_saved' };
}

module.exports = Object.freeze({
  saveConsent,
  saveQuickStart,
  saveEducationAndExperience,
  saveDraft,
  getDraft,
  savePersonalDetails,
  saveCareerIntent,
});
