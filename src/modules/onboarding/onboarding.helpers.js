'use strict';

/**
 * src/modules/onboarding/onboarding.helpers.js
 *
 * Shared helpers for the onboarding module.
 *
 * FIX: Added the following previously-missing exports that are imported
 * throughout the onboarding sub-services:
 *   - emitOnboardingEvent()     — intake, careerReport, cv, linkedin services
 *   - triggerProvisionalChi()   — intake, careerReport, linkedin services
 *   - callAnthropicWithRetry()  — careerReport, cv services
 *   - deductCredits()           — careerReport, cv services
 *   - triggerResumeScoring()    — cv service
 *
 * FIX: mergeStepHistory() now reads with .eq('user_id', userId) consistently,
 * matching the PK/FK layout of onboarding_progress where the row's unique
 * identity is the user_id column (id = internal PK, user_id = user FK).
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const TABLE_PROGRESS   = 'onboarding_progress';
const TABLE_USERS      = 'user_profiles';
const TABLE_PROFILES   = 'user_profiles';
const TABLE_IDEMPOTENCY = 'idempotency_keys';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const URL_TTL_MS         =  7 * 24 * 60 * 60 * 1000;

const CHI_TREND_THRESHOLD = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers
// ─────────────────────────────────────────────────────────────────────────────

function stripJson(text = '') {
  return String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function stripHtml(str) {
  return typeof str === 'string' ? str.replace(/<[^>]*>/g, '').trim() : '';
}

function sanitiseInput(value, opts = {}) {
  if (value == null) {
    return opts.allowEmpty === false ? null : '';
  }

  const stripped = stripHtml(String(value));
  const trimmed  = opts.maxLength ? stripped.slice(0, opts.maxLength) : stripped;

  return opts.allowEmpty === false && !trimmed ? null : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency helpers
// ─────────────────────────────────────────────────────────────────────────────

async function checkIdempotencyKey(userId, operation, key) {
  if (!key) return null;

  const id = `${userId}:${operation}:${key}`;

  const { data, error } = await supabase
    .from(TABLE_IDEMPOTENCY)
    .select('result, created_at')
    .eq('id', id)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    logger.warn('[Helpers] idempotency read failed', { userId, operation, error: error.message });
    return null;
  }

  if (!data) return null;

  const expired = Date.now() - new Date(data.created_at).getTime() > IDEMPOTENCY_TTL_MS;

  if (expired) {
    await supabase.from(TABLE_IDEMPOTENCY).delete().eq('id', id);
    return null;
  }

  return data.result;
}

async function saveIdempotencyKey(userId, operation, key, result) {
  if (!key) return;

  const id = `${userId}:${operation}:${key}`;

  const { error } = await supabase.from(TABLE_IDEMPOTENCY).upsert({
    id,
    user_id:         userId,
    operation,
    idempotency_key: key,
    result,
    created_at:      new Date().toISOString(),
  });

  if (error) {
    logger.warn('[Helpers] idempotency write failed', { userId, operation, error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step history
// FIX: Always query AND write by user_id to be consistent with RLS policy
// (which uses user_id) and with how the row is uniquely identified.
// ─────────────────────────────────────────────────────────────────────────────

async function mergeStepHistory(userId, newStep) {
  const { data, error } = await supabase
    .from(TABLE_PROGRESS)
    .select('step_history')
    .eq('user_id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    logger.warn('[Helpers] step history read failed', { userId, error: error.message });
  }

  const existing = Array.isArray(data?.step_history) ? data.step_history : [];

  return [
    ...existing.slice(-49),
    { step: newStep, at: new Date().toISOString() },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills merge
// ─────────────────────────────────────────────────────────────────────────────

function mergeSkills(trackBSkills = [], trackASkills = []) {
  const map = new Map();

  for (const source of [trackASkills, trackBSkills]) {
    for (const skill of source) {
      const name =
        typeof skill === 'string'
          ? skill.trim()
          : String(skill?.name || '').trim();

      if (!name) continue;

      map.set(name.toLowerCase(), {
        name,
        proficiency: skill?.proficiency || 'intermediate',
      });
    }
  }

  return [...map.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Region inference
// ─────────────────────────────────────────────────────────────────────────────

function inferRegion(country, city, preferredWorkLocation = null) {
  const text = `${preferredWorkLocation || country || ''} ${city || ''}`.toLowerCase();

  if (['uae', 'dubai', 'saudi', 'qatar'].some((k) => text.includes(k))) {
    return 'Gulf (UAE/Saudi)';
  }

  if (['uk', 'london'].some((k) => text.includes(k))) {
    return 'United Kingdom';
  }

  return 'India';
}

// ─────────────────────────────────────────────────────────────────────────────
// AI context builder
// ─────────────────────────────────────────────────────────────────────────────

function buildAIContext(onboarding = {}, profile = {}) {
  const mergedSkills = mergeSkills(profile.skills || [], onboarding.skills || []);

  return {
    city:       profile.current_city  || onboarding.personal_details?.city    || null,
    country:    profile.current_country || onboarding.personal_details?.country || null,
    targetRole: onboarding.target_role_id || profile.target_role_id || profile.expected_role_ids?.[0] || null,
    skillsWithProficiency: mergedSkills,
    userRegion: inferRegion(profile.current_country, profile.current_city, profile.preferred_work_location),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Completion logic
// ─────────────────────────────────────────────────────────────────────────────

function evaluateCompletion(progress = {}, profile = {}) {
  // Track A: manual education + experience entry + career report
  const trackA =
    Boolean(progress.education?.length || progress.experience?.length) &&
    Boolean(progress.career_report);

  // Track A-Upload: CV uploaded + personal details present
  const trackAUpload =
    Boolean(progress.cv_resume_id) &&
    Boolean(progress.personal_details?.full_name || progress.full_name);

  // Track B: career history + expected roles in profile
  const trackB =
    Boolean(profile.career_history?.length) &&
    Boolean(profile.expected_role_ids?.length);

  return {
    isComplete: trackA || trackAUpload || trackB,
    trackA,
    trackAUpload,
    trackB,
  };
}

async function persistCompletionIfReady(userId, progressData, profileData) {
  if (profileData?.onboarding_completed === true) return;

  const completion = evaluateCompletion(progressData, profileData);

  if (!completion.isComplete) return;

  const now         = new Date().toISOString();
  const stepHistory = await mergeStepHistory(userId, 'onboarding_completed');

  const writes = await Promise.all([
    supabase.from(TABLE_PROFILES).update({
      onboarding_completed:    true,
      onboarding_completed_at: now,
      updated_at:              now,
    }).eq('id', userId),

    supabase.from(TABLE_USERS).update({
      onboarding_completed:    true,
      onboarding_completed_at: now,
      updated_at:              now,
      ...(progressData?.cv_resume_id
        ? { resume_uploaded: true, latest_resume_id: progressData.cv_resume_id }
        : {}),
    }).eq('id', userId),

    supabase.from(TABLE_PROGRESS).update({
      completed_at: now,
      step_history: stepHistory,
      updated_at:   now,
    }).eq('user_id', userId),
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

  logger.info('[Helpers] onboarding completed', { userId });
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX: emitOnboardingEvent — previously imported throughout onboarding sub-
// services but never defined or exported from this module.
// All callers (intake, careerReport, cv, linkedin) import it from here.
// ─────────────────────────────────────────────────────────────────────────────

function emitOnboardingEvent(userId, eventName, payload = {}) {
  // Structured log so events are queryable in production observability.
  logger.info('[OnboardingEvent]', { userId, eventName, payload });

  // When the async event bus is enabled, forward to the pipeline.
  if (process.env.FEATURE_EVENT_BUS === 'true') {
    try {
      const { publishEvent } = require('../ai-event-bus/bus/aiEventBus');
      publishEvent(eventName, { userId, ...payload }).catch((err) => {
        logger.warn('[OnboardingEvent] publish failed', { eventName, error: err.message });
      });
    } catch {
      // Non-fatal — event bus may not be loaded in all environments
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX: triggerProvisionalChi — previously imported throughout onboarding sub-
// services but never defined or exported from this module.
// ─────────────────────────────────────────────────────────────────────────────

async function triggerProvisionalChi(userId, progress, profile, resumeId, tier) {
  try {
    logger.info('[ProvisionalCHI] Trigger queued', { userId, tier });

    // When the internal CHI route is configured, call it via Cloud Tasks or directly.
    const internalUrl = process.env.INTERNAL_BASE_URL
      ? `${process.env.INTERNAL_BASE_URL}/api/v1/internal/provisional-chi`
      : null;

    if (!internalUrl) {
      logger.debug('[ProvisionalCHI] INTERNAL_BASE_URL not set — skipping HTTP trigger');
      return;
    }

    const token = process.env.INTERNAL_SERVICE_TOKEN;
    if (!token) {
      logger.warn('[ProvisionalCHI] INTERNAL_SERVICE_TOKEN not set — skipping');
      return;
    }

    // Fire-and-forget — do not await the response
    fetch(internalUrl, {
      method:  'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-internal-service-token': token,
      },
      body:   JSON.stringify({ userId, tier, resumeId }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      logger.warn('[ProvisionalCHI] HTTP trigger failed (non-fatal)', { error: err.message });
    });
  } catch (err) {
    logger.warn('[ProvisionalCHI] Failed to trigger (non-fatal)', { userId, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX: callAnthropicWithRetry — imported by careerReport + cv services.
// Thin wrapper around the Anthropic client with retry semantics.
// ─────────────────────────────────────────────────────────────────────────────

async function callAnthropicWithRetry(callFn, { maxRetries = 2, timeoutMs = 20000 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await Promise.race([
        callFn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AI_TIMEOUT')), timeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      lastError = err;
      logger.warn('[callAnthropicWithRetry] attempt failed', {
        attempt: attempt + 1,
        error:   err.message,
      });

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX: deductCredits — imported by careerReport + cv services.
// Delegates to the creditGuard RPC for atomic credit deduction.
// ─────────────────────────────────────────────────────────────────────────────

async function deductCredits(userId, creditCost, idempotencyKey = null) {
  if (!creditCost || creditCost <= 0) return;

  try {
    const { data, error } = await supabase.rpc('consume_ai_credits', {
      p_user_id: userId,
      p_cost:    Math.trunc(Number(creditCost)),
    });

    if (error) {
      logger.error('[deductCredits] RPC failed', { userId, creditCost, error: error.message });
      throw error;
    }

    return data;
  } catch (err) {
    logger.error('[deductCredits] Failed to deduct credits', { userId, creditCost, error: err.message });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX: triggerResumeScoring — imported by cv service.
// Enqueues a background resume scoring job.
// ─────────────────────────────────────────────────────────────────────────────

async function triggerResumeScoring(userId, resumeId, tier = 'free') {
  try {
    logger.info('[triggerResumeScoring] Queuing score job', { userId, resumeId, tier });

    const { enqueueAiJob } = require('../../core/aiJobQueue');

    await enqueueAiJob({
      userId,
      operationType: 'fullAnalysis',
      dedupeKey:     `score:${userId}:${resumeId}`,
      payload:       { resumeId, tier },
      tier,
    });
  } catch (err) {
    // Non-fatal — scoring is a background enhancement
    logger.warn('[triggerResumeScoring] Failed (non-fatal)', { userId, resumeId, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  // Text
  stripJson,
  stripHtml,
  sanitiseInput,

  // Idempotency
  checkIdempotencyKey,
  saveIdempotencyKey,

  // Step history + completion
  mergeStepHistory,
  evaluateCompletion,
  persistCompletionIfReady,

  // Data helpers
  mergeSkills,
  inferRegion,
  buildAIContext,

  // AI helpers — FIX: were missing, caused TypeError across all onboarding sub-services
  callAnthropicWithRetry,
  deductCredits,
  triggerResumeScoring,

  // Events — FIX: were missing, caused TypeError in intake + careerReport + cv + linkedin
  emitOnboardingEvent,
  triggerProvisionalChi,

  // Constants
  MODEL,
  IDEMPOTENCY_TTL_MS,
  URL_TTL_MS,
  CHI_TREND_THRESHOLD,
});
