'use strict';

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const TABLE_PROGRESS = 'onboarding_progress';
const TABLE_USERS = 'user_profiles';
const TABLE_PROFILES = 'user_profiles';
const TABLE_IDEMPOTENCY = 'idempotency_keys';

const MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';

const IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1000;

const URL_TTL_MS =
  7 * 24 * 60 * 60 * 1000;

const CHI_TREND_THRESHOLD = 5;

function stripJson(text = '') {
  return String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function stripHtml(str) {
  return typeof str === 'string'
    ? str.replace(/<[^>]*>/g, '').trim()
    : '';
}

function sanitiseInput(value, opts = {}) {
  if (value == null) {
    return opts.allowEmpty === false ? null : '';
  }

  const stripped = stripHtml(String(value));
  const trimmed = opts.maxLength
    ? stripped.slice(0, opts.maxLength)
    : stripped;

  return opts.allowEmpty === false && !trimmed
    ? null
    : trimmed;
}

async function checkIdempotencyKey(
  userId,
  operation,
  key
) {
  if (!key) return null;

  const id = `${userId}:${operation}:${key}`;

  const { data, error } = await supabase
    .from(TABLE_IDEMPOTENCY)
    .select('result, created_at')
    .eq('id', id)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    logger.warn('[Helpers] idempotency read failed', {
      userId,
      operation,
      error: error.message,
    });
    return null;
  }

  if (!data) return null;

  const expired =
    Date.now() -
      new Date(data.created_at).getTime() >
    IDEMPOTENCY_TTL_MS;

  if (expired) {
    await supabase
      .from(TABLE_IDEMPOTENCY)
      .delete()
      .eq('id', id);

    return null;
  }

  return data.result;
}

async function saveIdempotencyKey(
  userId,
  operation,
  key,
  result
) {
  if (!key) return;

  const id = `${userId}:${operation}:${key}`;

  const { error } = await supabase
    .from(TABLE_IDEMPOTENCY)
    .upsert({
      id,
      user_id: userId,
      operation,
      idempotency_key: key,
      result,
      created_at: new Date().toISOString(),
    });

  if (error) {
    logger.warn('[Helpers] idempotency write failed', {
      userId,
      operation,
      error: error.message,
    });
  }
}

async function mergeStepHistory(userId, newStep) {
  const { data, error } = await supabase
    .from(TABLE_PROGRESS)
    .select('step_history')
    .eq('user_id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    logger.warn('[Helpers] step history read failed', {
      userId,
      error: error.message,
    });
  }

  const existing = Array.isArray(data?.step_history)
    ? data.step_history
    : [];

  return [
    ...existing.slice(-49),
    {
      step: newStep,
      at: new Date().toISOString(),
    },
  ];
}

function mergeSkills(
  trackBSkills = [],
  trackASkills = []
) {
  const map = new Map();

  for (const source of [
    trackASkills,
    trackBSkills,
  ]) {
    for (const skill of source) {
      const name =
        typeof skill === 'string'
          ? skill.trim()
          : String(skill?.name || '').trim();

      if (!name) continue;

      map.set(name.toLowerCase(), {
        name,
        proficiency:
          skill?.proficiency ||
          'intermediate',
      });
    }
  }

  return [...map.values()];
}

function inferRegion(
  country,
  city,
  preferredWorkLocation = null
) {
  const text = `${preferredWorkLocation || country || ''} ${city || ''}`.toLowerCase();

  if (
    ['uae', 'dubai', 'saudi', 'qatar'].some(
      (k) => text.includes(k)
    )
  ) {
    return 'Gulf (UAE/Saudi)';
  }

  if (
    ['uk', 'london'].some((k) =>
      text.includes(k)
    )
  ) {
    return 'United Kingdom';
  }

  return 'India';
}

function buildAIContext(
  onboarding = {},
  profile = {}
) {
  const mergedSkills = mergeSkills(
    profile.skills || [],
    onboarding.skills || []
  );

  return {
    city:
      profile.current_city ||
      onboarding.personal_details?.city ||
      null,
    country:
      profile.current_country ||
      onboarding.personal_details?.country ||
      null,
    targetRole:
      onboarding.target_role_id ||
      profile.target_role_id ||
      profile.expected_role_ids?.[0] ||
      null,
    skillsWithProficiency: mergedSkills,
    userRegion: inferRegion(
      profile.current_country,
      profile.current_city,
      profile.preferred_work_location
    ),
  };
}

function evaluateCompletion(
  progress = {},
  profile = {}
) {
  const trackA =
    Boolean(
      progress.education?.length ||
        progress.experience?.length
    ) && Boolean(progress.career_report);

  const trackAUpload =
    Boolean(progress.cv_resume_id) &&
    Boolean(
      progress.personal_details?.full_name
    );

  const trackB =
    Boolean(profile.career_history?.length) &&
    Boolean(
      profile.expected_role_ids?.length
    );

  return {
    isComplete:
      trackA || trackAUpload || trackB,
    trackA,
    trackAUpload,
    trackB,
  };
}

async function persistCompletionIfReady(
  userId,
  progressData,
  profileData
) {
  if (profileData?.onboarding_completed === true) {
    return;
  }

  const completion = evaluateCompletion(
    progressData,
    profileData
  );

  if (!completion.isComplete) {
    return;
  }

  const now = new Date().toISOString();
  const stepHistory = await mergeStepHistory(
    userId,
    'onboarding_completed'
  );

  const writes = await Promise.all([
    supabase
      .from(TABLE_PROFILES)
      .update({
        onboarding_completed: true,
        onboarding_completed_at: now,
        updated_at: now,
      })
      .eq('id', userId),

    supabase
      .from(TABLE_USERS)
      .update({
        onboarding_completed: true,
        onboarding_completed_at: now,
        updated_at: now,
        ...(progressData?.cv_resume_id
          ? {
              resume_uploaded: true,
              latest_resume_id:
                progressData.cv_resume_id,
            }
          : {}),
      })
      .eq('id', userId),

    supabase
      .from(TABLE_PROGRESS)
      .update({
        completed_at: now,
        step_history: stepHistory,
        updated_at: now,
      })
      .eq('user_id', userId),
  ]);

  const failed = writes.find((w) => w.error);
  if (failed?.error) {
    throw new AppError(
      'Failed to persist onboarding completion',
      500,
      { userId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  logger.info('[Helpers] onboarding completed', {
    userId,
  });
}

module.exports = Object.freeze({
  stripJson,
  stripHtml,
  sanitiseInput,
  checkIdempotencyKey,
  saveIdempotencyKey,
  mergeSkills,
  inferRegion,
  buildAIContext,
  mergeStepHistory,
  evaluateCompletion,
  persistCompletionIfReady,
  MODEL,
  IDEMPOTENCY_TTL_MS,
  URL_TTL_MS,
  CHI_TREND_THRESHOLD,
});