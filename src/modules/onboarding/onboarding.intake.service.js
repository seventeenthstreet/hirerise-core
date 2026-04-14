'use strict';

/**
 * src/modules/onboarding/onboarding.intake.service.js
 *
 * Patch 32: Final production-hardened intake workflow service
 * - centralized validation
 * - safe async CHI trigger
 * - strict metadata-rich AppErrors
 * - deterministic progress ownership
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
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

const CONFLICT_KEYS = Object.freeze({
  [TABLE_PROGRESS]: 'id',
  [TABLE_USERS]: 'id',
  [TABLE_PROFILES]: 'id',
});

function requireUserId(userId) {
  if (!userId) {
    throw new AppError(
      'userId required',
      400,
      { userId },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

function nowISO() {
  return new Date().toISOString();
}

async function safeUpsert(table, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new AppError(
      'Invalid upsert payload',
      400,
      { table },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const { error } = await supabase
    .from(table)
    .upsert(payload, {
      onConflict: CONFLICT_KEYS[table] || 'id',
    });

  if (error) {
    logger.error('[OnboardingIntake] upsert failed', {
      table,
      error: error.message,
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
    logger.error('[OnboardingIntake] read failed', {
      table,
      userId,
      error: error.message,
    });
    throw error;
  }

  return data || {};
}

async function writeProgress(userId, step, payload = {}) {
  const updated_at = nowISO();
  const step_history = await mergeStepHistory(userId, step);

  await safeUpsert(TABLE_PROGRESS, {
    id: userId,
    step,
    ...payload,
    step_history,
    updated_at,
  });

  return { updated_at, step_history };
}

async function saveConsent(userId, payload) {
  requireUserId(userId);

  const { consentVersion } = payload || {};
  if (!consentVersion) {
    throw new AppError(
      'consentVersion required',
      400,
      { payload },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const existing = await safeRead(
    TABLE_PROGRESS,
    userId,
    'consent_version'
  );

  if (existing?.consent_version === consentVersion) {
    return { userId, alreadyRecorded: true };
  }

  const now = nowISO();

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

    writeProgress(userId, 'consent_saved', {
      consent_version: consentVersion,
      consent_granted_at: now,
    }),
  ]);

  emitOnboardingEvent(userId, 'onboarding_step_completed', {
    step: 'consent_saved',
  });

  return { userId, step: 'consent_saved' };
}

async function saveQuickStart(userId, payload) {
  requireUserId(userId);

  const {
    jobTitle,
    company,
    startDate,
    skills = [],
  } = payload || {};

  if (!jobTitle || !company || !startDate) {
    throw new AppError(
      'Missing required fields',
      400,
      { payload },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const experience = [
    {
      job_title: stripHtml(jobTitle),
      company: stripHtml(company),
      start_date: startDate,
    },
  ];

  await Promise.all([
    writeProgress(userId, 'quick_start_saved', {
      experience,
      skills,
    }),

    safeUpsert(TABLE_PROFILES, {
      id: userId,
      skills,
      updated_at: nowISO(),
    }),
  ]);

  Promise.resolve()
    .then(() =>
      triggerProvisionalChi(userId, {}, {}, null, 'free')
    )
    .catch((error) => {
      logger.warn(
        '[OnboardingIntake] Provisional CHI trigger failed',
        {
          userId,
          error: error.message,
        }
      );
    });

  return { userId, step: 'quick_start_saved' };
}

async function saveEducationAndExperience(userId, payload) {
  requireUserId(userId);

  const {
    education = [],
    experience = [],
    skills = [],
  } = payload || {};

  if (!education.length && !experience.length) {
    throw new AppError(
      'At least one entry required',
      400,
      { payload },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  validateExperienceDates(experience);

  const totalExperienceMonths =
    computeExperienceMonths(experience);

  await Promise.all([
    writeProgress(userId, 'education_experience_saved', {
      education,
      experience,
      skills,
      total_experience_months:
        totalExperienceMonths,
    }),

    safeUpsert(TABLE_PROFILES, {
      id: userId,
      skills,
      updated_at: nowISO(),
    }),
  ]);

  const [progress, profile] = await Promise.all([
    safeRead(TABLE_PROGRESS, userId),
    safeRead(TABLE_PROFILES, userId),
  ]);

  await persistCompletionIfReady(
    userId,
    progress,
    profile
  );

  return {
    userId,
    step: 'education_experience_saved',
  };
}

async function saveDraft(userId, payload) {
  requireUserId(userId);

  await writeProgress(userId, 'draft', {
    draft: payload,
  });

  return { userId, step: 'draft' };
}

async function getDraft(userId) {
  requireUserId(userId);

  const data = await safeRead(
    TABLE_PROGRESS,
    userId,
    'draft'
  );

  return {
    userId,
    draft: data?.draft || null,
  };
}

async function savePersonalDetails(userId, payload) {
  requireUserId(userId);

  const { fullName, email } = payload || {};
  if (!fullName || !email) {
    throw new AppError(
      'Missing required fields',
      400,
      { payload },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  await writeProgress(userId, 'personal_details_saved', {
    personal_details: payload,
  });

  return {
    userId,
    step: 'personal_details_saved',
  };
}

async function saveCareerIntent(userId, payload) {
  requireUserId(userId);

  if (!payload?.expectedRoleIds?.length) {
    throw new AppError(
      'expectedRoleIds required',
      400,
      { payload },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  await Promise.all([
    safeUpsert(TABLE_PROFILES, {
      id: userId,
      expected_role_ids: payload.expectedRoleIds,
      updated_at: nowISO(),
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