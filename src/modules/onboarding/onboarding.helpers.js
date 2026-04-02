'use strict';

/**
 * onboarding.helpers.js — B-01 FIX: Shared internal helpers
 *
 * Extracted from onboarding.service.js as part of the god-object decomposition.
 * These utilities are used across multiple onboarding sub-services.
 *
 * Do NOT import this from outside the onboarding module — these are internals.
 * External callers should use the specific sub-service (cv, intake, etc.).
 *
 * MIGRATED: All Firestore db.collection() calls replaced with supabase.from()
 * FieldValue.serverTimestamp() → new Date().toISOString()
 * FieldValue.arrayUnion()     → array spread merge (handled at write site)
 * batch()                     → Promise.all([...])
 * Transactions                → sequential awaits (best-effort)
 */

const crypto    = require('crypto');
const supabase  = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger          = require('../../utils/logger');
const { getQualificationById } = require('../qualification/qualification.service');
const { logAIInteraction }     = require('../../infrastructure/aiLogger');
const { getRemainingQuota }    = require('../../middleware/tierquota.middleware');
const { conversionEventService } = require('../conversion');
const { INDUSTRY_SECTORS }     = require('../roles/roles.types');
const { validateRolesExist }   = require('../roles/roles.service');
const { publishEvent }           = require('../../shared/pubsub');
const { scoreResume }            = require('../resume/resume.service');
const { calculateProvisionalChi } = require('../careerHealthIndex/careerHealthIndex.service');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHI_TREND_THRESHOLD = 5;

const VALID_SENIORITY = new Set([
  'junior', 'mid', 'senior', 'lead',
  'manager', 'director', 'vp', 'c_suite',
]);

const EXPERIENCE_TYPE_WEIGHTS = Object.freeze({
  full_time:   1.0,
  part_time:   0.7,
  contract:    0.8,
  freelance:   0.7,
  internship:  0.5,
  volunteer:   0.4,
  open_source: 0.5,
});
const VALID_EXPERIENCE_TYPES = new Set(Object.keys(EXPERIENCE_TYPE_WEIGHTS));

function validateAchievements(achievements, label) {
  if (!Array.isArray(achievements) || achievements.length === 0) return [];
  if (achievements.length > 5) {
    throw new AppError(
      `${label}: Maximum 5 achievements allowed (got ${achievements.length}).`,
      400, { label }, ErrorCodes.VALIDATION_ERROR
    );
  }
  return achievements.map((a, i) => {
    if (!a || typeof a !== 'object') {
      throw new AppError(`${label}: achievements[${i}] must be an object.`, 400, { label, index: i }, ErrorCodes.VALIDATION_ERROR);
    }
    const action = stripHtml(String(a.action || '')).trim();
    if (!action) {
      throw new AppError(
        `${label}: achievements[${i}].action is required (e.g. "reduced API latency").`,
        400, { label, index: i }, ErrorCodes.VALIDATION_ERROR
      );
    }
    if (action.length < 5 || action.length > 200) {
      throw new AppError(
        `${label}: achievements[${i}].action must be between 5 and 200 characters.`,
        400, { label, index: i }, ErrorCodes.VALIDATION_ERROR
      );
    }
    return {
      metric:  a.metric  ? stripHtml(String(a.metric)).trim().slice(0, 50)  : null,
      action,
      context: a.context ? stripHtml(String(a.context)).trim().slice(0, 200) : null,
    };
  });
}

// SPRINT-4A M4: Anthropic API retry with exponential backoff.
// The Anthropic API returns HTTP 529 (Overloaded) during high-traffic windows.
// Without retry, a single 529 fails the user's request — causing visible errors
// during peak usage. Three retries with exponential backoff (1s → 2s → 4s)
// resolves the vast majority of transient overload windows without user impact.
//
// Only retries on 529 (overloaded) and 503 (service unavailable) — not on 4xx
// (validation errors, auth failures) which would never succeed on retry.
const ANTHROPIC_RETRY_MAX       = parseInt(process.env.ANTHROPIC_RETRY_MAX       || '3',    10);
const ANTHROPIC_RETRY_BASE_MS   = parseInt(process.env.ANTHROPIC_RETRY_BASE_MS   || '1000', 10);
const ANTHROPIC_RETRY_STATUSES  = new Set([529, 503]);

async function callAnthropicWithRetry(createFn, { module: mod, model, userId }) {
  let attempt   = 0;
  let lastError = null;
  const startMs = Date.now();

  while (attempt <= ANTHROPIC_RETRY_MAX) {
    try {
      const response = await createFn();
      if (attempt > 0) {
        logger.info(`[OnboardingService] M4: Anthropic call succeeded after ${attempt} retry(s)`, { module: mod, userId, attempt });
      }
      logAIInteraction({ module: mod, model, usage: response.usage ?? {}, latencyMs: Date.now() - startMs, status: 'success', userId });
      return response;
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode || (err.response?.status);
      const isRetryable = ANTHROPIC_RETRY_STATUSES.has(status);

      if (!isRetryable || attempt >= ANTHROPIC_RETRY_MAX) {
        logAIInteraction({ module: mod, model, latencyMs: Date.now() - startMs, status: 'error', error: err, userId });
        throw err;
      }

      const delayMs = ANTHROPIC_RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn(`[OnboardingService] M4: Anthropic overloaded (${status}) — retrying in ${delayMs}ms`, { module: mod, userId, attempt, status });
      await new Promise(resolve => setTimeout(resolve, delayMs));
      attempt++;
    }
  }

  // Should never reach here, but safety net
  throw lastError;
}


// The old setTimeout approach silently dropped scheduled nudges on every Node.js
// restart (deploy, crash, scale-up). At prod cadence (multiple deploys per week)
// this meant the majority of draft re-engagement notifications were never sent.
//
// New architecture:
//   1. saveDraft() writes a record to notificationJobs/{jobId} (state: 'pending')
//   2. scheduleReengagementJob() enqueues a Cloud Tasks HTTP task pointing at
//      POST /internal/notifications/draft-reengagement (scheduled 24h from now)
//   3. The tasks handler fires, re-reads onboardingProgress, sends notification
//      if user hasn't progressed, then marks notificationJobs/{jobId} delivered/skipped
//
// Fallback: if CLOUD_TASKS_QUEUE_PATH is not set (local dev / first deploy),
// the function falls back to the old setTimeout so dev environments still work.
const DRAFT_REENGAGEMENT_DELAY_MS     = 24 * 60 * 60 * 1000; // 24 h — used by fallback only
const NOTIFICATION_JOBS_COLLECTION    = 'notificationJobs';
const INTERNAL_REENGAGEMENT_ENDPOINT  = process.env.INTERNAL_REENGAGEMENT_URL
  || `${process.env.API_BASE_URL || 'http://localhost:3001'}/internal/notifications/draft-reengagement`;
const CLOUD_TASKS_QUEUE_PATH          = process.env.CLOUD_TASKS_QUEUE_PATH || null;
// Legacy Pub/Sub topic kept for other notification types — not used by draft re-engagement after H6
const NOTIFICATION_TOPIC = process.env.PUBSUB_TOPIC_NOTIFICATION
  || 'hirerise.notification.requested.v1';

const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function stripJson(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// GAP T3: strip HTML tags from free-text fields
function stripHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim();
}

/**
 * P4-07: sanitiseInput(value, options) — centralised XSS/injection sanitiser.
 *
 * Replaces ad-hoc stripHtml() calls scattered across the service with a single
 * function that handles the full surface area:
 *   1. Strip all HTML tags (XSS prevention — removes tags, retains text nodes)
 *      e.g. "<b>Hello</b>" → "Hello", "<script>alert(1)</script>" → "alert(1)"
 *      IMPORTANT: Never render sanitised output as innerHTML — use textContent.
 *   2. Trim whitespace
 *   3. Enforce maxLength if provided
 *   4. Replace null/undefined with '' (safe default)
 *
 * Usage:
 *   sanitiseInput(value)                    → strip + trim
 *   sanitiseInput(value, { maxLength: 200 }) → strip + trim + truncate
 *   sanitiseInput(value, { allowEmpty: false }) → returns null if empty after stripping
 *
 * @param {any}    value
 * @param {object} [opts]
 * @param {number} [opts.maxLength]    — truncate to this many characters after sanitising
 * @param {boolean}[opts.allowEmpty]   — if false, returns null when result is empty string
 * @returns {string|null}
 */
function sanitiseInput(value, opts = {}) {
  if (value === null || value === undefined) return opts.allowEmpty === false ? null : '';
  const str     = stripHtml(String(value));
  const trimmed = opts.maxLength ? str.slice(0, opts.maxLength) : str;
  if (opts.allowEmpty === false && !trimmed) return null;
  return trimmed;
}

// GAP S8: URL validation
function validateUrl(url, fieldName) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Bad protocol');
    return url.trim();
  } catch {
    throw new AppError(
      `${fieldName} must be a valid URL (e.g. https://linkedin.com/in/yourname).`,
      400, { fieldName, url }, ErrorCodes.VALIDATION_ERROR
    );
  }
}

// GAP S10: graduation year range validation
function validateYearOfGraduation(year, label) {
  if (year == null) return null;
  const y = parseInt(year, 10);
  const minY = 1950, maxY = new Date().getFullYear() + 6;
  if (isNaN(y) || y < minY || y > maxY) {
    throw new AppError(
      `${label}: yearOfGraduation "${year}" must be between ${minY} and ${maxY}.`,
      400, { label, year }, ErrorCodes.VALIDATION_ERROR
    );
  }
  return y;
}

// GAP T3: validate and sanitise responsibilities array
function validateAndSanitiseResponsibilities(responsibilities, label) {
  if (!Array.isArray(responsibilities)) return [];
  const sanitised = responsibilities.map(r => stripHtml(String(r || ''))).filter(r => r.length > 0);
  if (sanitised.length === 0) return [];
  if (sanitised.length > 10) throw new AppError(`${label}: Maximum 10 responsibility bullets allowed (got ${sanitised.length}).`, 400, { label }, ErrorCodes.VALIDATION_ERROR);
  for (let i = 0; i < sanitised.length; i++) {
    if (sanitised[i].length < 10) throw new AppError(`${label}: Bullet ${i+1} too short (min 10 chars). Try: "Led API migration reducing latency by 30%"`, 400, { label, index: i }, ErrorCodes.VALIDATION_ERROR);
    if (sanitised[i].length > 500) throw new AppError(`${label}: Bullet ${i+1} too long (max 500 chars, got ${sanitised[i].length}).`, 400, { label, index: i }, ErrorCodes.VALIDATION_ERROR);
  }
  return sanitised;
}

// GAP T4: idempotency key management
async function checkIdempotencyKey(userId, operation, key) {
  if (!key) return null;
  try {
    const docId = `${userId}:${operation}:${key}`;
    const { data, error } = await supabase
      .from('idempotencyKeys')
      .select('*')
      .eq('id', docId)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') {
      logger.warn('[DB] idempotencyKeys.get error', { error: error.message });
    }
    if (!data) return null;
    if (Date.now() - new Date(data.createdAt).getTime() > IDEMPOTENCY_TTL_MS) {
      await supabase.from('idempotencyKeys').delete().eq('id', docId);
      return null;
    }
    return data.result;
  } catch { return null; }
}

async function saveIdempotencyKey(userId, operation, key, result) {
  if (!key) return;
  try {
    const docId = `${userId}:${operation}:${key}`;
    const { error } = await supabase
      .from('idempotencyKeys')
      .upsert({ id: docId, userId, operation, key, result, createdAt: new Date().toISOString() });
    if (error) {
      logger.warn('[OnboardingService] Idempotency key save failed', { userId, operation, error: error.message });
    }
  } catch (err) {
    logger.warn('[OnboardingService] Idempotency key save failed', { userId, operation, error: err.message });
  }
}

// GAP S5: merge skills from Track A and Track B — Track B wins on duplicate name
function mergeSkills(trackBSkills = [], trackASkills = []) {
  const map = new Map();
  for (const s of trackASkills) {
    const name = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
    if (!name) continue;
    map.set(name.toLowerCase(), { name, proficiency: s?.proficiency || 'intermediate' });
  }
  for (const s of trackBSkills) {
    const name = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
    if (!name) continue;
    map.set(name.toLowerCase(), { name, proficiency: s?.proficiency || 'intermediate' });
  }
  return Array.from(map.values());
}

// GAP-06: Compute total experience months from Track A date ranges (server-side)
// Handles isCurrent:true entries by using today as endDate.
// YYYY-MM strings are converted to the 1st of that month for arithmetic.
function computeExperienceMonths(experience = []) {
  const now = new Date();
  let total = 0;
  for (const exp of experience) {
    if (!exp.startDate) continue;
    const start = new Date(exp.startDate + '-01');
    const end   = exp.isCurrent
      ? now
      : exp.endDate ? new Date(exp.endDate + '-01') : null;
    if (!end || end < start) continue;
    const months = (end.getFullYear() - start.getFullYear()) * 12
                 + (end.getMonth()    - start.getMonth());
    total += Math.max(0, months);
  }
  return total;
}

// GAP C2: infer user market region from country/city
// SPRINT-2 C6: preferredWorkLocation is now the primary signal.
// A user in Bangalore targeting Dubai must be benchmarked against Gulf salary bands —
// not India bands. preferredWorkLocation overrides currentCity/country for CHI scoring.
function inferRegion(country, city, preferredWorkLocation = null) {
  const c = ((preferredWorkLocation || country || '') + ' ' + (city || '')).toLowerCase();
  if (['ae', 'uae', 'dubai', 'abu dhabi', 'sharjah', 'saudi', 'qatar', 'bahrain', 'kuwait', 'oman'].some(k => c.includes(k))) return 'Gulf (UAE/Saudi)';
  if (['uk', 'gb', 'united kingdom', 'london', 'manchester'].some(k => c.includes(k))) return 'United Kingdom';
  if (['us', 'usa', 'united states'].some(k => c.includes(k))) return 'United States';
  if (['sg', 'singapore'].some(k => c.includes(k))) return 'Singapore';
  if (['au', 'australia'].some(k => c.includes(k))) return 'Australia';
  return 'India';
}

// ─── Background task helpers ──────────────────────────────────────────────────

// SPRINT-3 H6: Schedule a draft re-engagement notification via Cloud Tasks.
// Writes a notificationJobs record first so the job is durable even if the
// Cloud Tasks enqueue call fails — an operator can replay missed jobs by
// querying notificationJobs where status == 'pending' and scheduledAt < now.
async function scheduleReengagementJob(userId) {
  if (process.env.NODE_ENV === 'test') return;

  const jobId      = `draft-reengagement:${userId}:${Date.now()}`;
  const scheduledAt = new Date(Date.now() + DRAFT_REENGAGEMENT_DELAY_MS);

  // 1. Write durable job record — survives process restarts
  try {
    const { error } = await supabase
      .from(NOTIFICATION_JOBS_COLLECTION)
      .upsert({
        id:          jobId,
        jobId,
        userId,
        type:        'ONBOARDING_DRAFT_REENGAGEMENT',
        status:      'pending',
        scheduledAt: scheduledAt.toISOString(),
        createdAt:   new Date().toISOString(),
      });
    if (error) {
      logger.warn('[OnboardingService] Failed to write notificationJobs record — re-engagement not scheduled', { userId, error: error.message });
      return; // do not enqueue if the record write failed — avoids orphaned tasks
    }
  } catch (err) {
    logger.warn('[OnboardingService] Failed to write notificationJobs record — re-engagement not scheduled', { userId, error: err.message });
    return;
  }

  // 2a. Cloud Tasks path — production
  if (CLOUD_TASKS_QUEUE_PATH) {
    try {
      const { CloudTasksClient } = require('@google-cloud/tasks');
      const client = new CloudTasksClient();
      const scheduleTimeSeconds = Math.floor(scheduledAt.getTime() / 1000);

      await client.createTask({
        parent: CLOUD_TASKS_QUEUE_PATH,
        task: {
          scheduleTime: { seconds: scheduleTimeSeconds },
          httpRequest: {
            httpMethod: 'POST',
            url: INTERNAL_REENGAGEMENT_ENDPOINT,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify({ userId, jobId })).toString('base64'),
          },
        },
      });

      logger.info('[OnboardingService] Draft re-engagement task enqueued via Cloud Tasks', {
        userId, jobId, scheduledAt: scheduledAt.toISOString(),
      });
    } catch (err) {
      // Task enqueue failed — the notificationJobs record is still written,
      // so an operator can replay. Do not throw; never block the draft save response.
      logger.warn('[OnboardingService] Cloud Tasks enqueue failed — job recorded for manual replay', {
        userId, jobId, error: err.message,
      });
    }
    return;
  }

  // 2b. setTimeout fallback — local dev / environments without Cloud Tasks configured.
  // Intentionally retained so dev environments work without GCP credentials.
  // This path is NOT used in production (CLOUD_TASKS_QUEUE_PATH must be set).
  logger.debug('[OnboardingService] CLOUD_TASKS_QUEUE_PATH not set — using setTimeout fallback (dev only)', { userId });
  setTimeout(async () => {
    try {
      const { data: progressRow, error: progressErr } = await supabase
        .from('onboardingProgress')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (progressErr && progressErr.code !== 'PGRST116') {
        logger.error('[DB] onboardingProgress.get:', progressErr.message);
      }
      if (!progressRow) return;

      const progressedSteps = ['education_experience_saved', 'career_report_generated',
        'personal_details_saved', 'cv_generated', 'cv_uploaded', 'completed_without_cv'];
      const hasProgressed = (progressRow.stepHistory || []).some(h => progressedSteps.includes(h.step));

      if (hasProgressed) {
        await supabase
          .from(NOTIFICATION_JOBS_COLLECTION)
          .upsert({ id: jobId, status: 'skipped', resolvedAt: new Date().toISOString() });
        return;
      }

      await publishEvent(NOTIFICATION_TOPIC, 'NOTIFICATION_REQUESTED', {
        userId,
        notificationType: 'ONBOARDING_DRAFT_REENGAGEMENT',
        data: { actionUrl: '/onboarding', message: 'You left your profile unfinished. Complete it to unlock your Career Health Score.' },
      });

      await supabase
        .from(NOTIFICATION_JOBS_COLLECTION)
        .upsert({ id: jobId, status: 'delivered', resolvedAt: new Date().toISOString() });
      logger.info('[OnboardingService] Draft re-engagement sent (setTimeout fallback)', { userId });
    } catch (err) {
      logger.warn('[OnboardingService] Draft re-engagement failed (setTimeout fallback)', { userId, error: err.message });
    }
  }, DRAFT_REENGAGEMENT_DELAY_MS);
}

// FIX G-01 + GAP T2: Background resume scoring — Pub/Sub preferred, setTimeout fallback
function triggerResumeScoring(userId, resumeId) {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.PUBSUB_TOPIC_RESUME_SCORE) {
    try {
      publishEvent(process.env.PUBSUB_TOPIC_RESUME_SCORE, { userId, resumeId, triggeredBy: 'onboarding' })
        .catch(err => logger.error('[OnboardingService] Pub/Sub resume-score publish failed', { userId, resumeId, error: err.message }));
      return;
    } catch (err) {
      logger.error('[OnboardingService] Pub/Sub import failed — fallback to setTimeout', { error: err.message });
    }
  }
  setTimeout(async () => {
    try {
      await scoreResume(userId, resumeId);
      logger.info('[OnboardingService] Auto-scoring complete', { userId, resumeId });
    } catch (err) {
      logger.error('[OnboardingService] Auto-scoring failed (non-fatal)', { userId, resumeId, error: err.message });
    }
  }, 3000);
}

// GAP S2: Provisional CHI after career report
// HOTFIX: accepts userTier so CHI service can downgrade model for free users
/**
 * triggerProvisionalChi — C-09 FIX
 *
 * Enqueues a Cloud Tasks HTTP task to calculate provisional CHI asynchronously.
 * This replaces the previous setTimeout(fn, 2000) approach which was fragile:
 * under Cloud Run CPU throttling, the callback could be silently dropped if
 * the instance scaled down before the 2-second timer fired.
 *
 * Cloud Tasks is retryable, observable, and survives instance restarts.
 *
 * Production path:  CLOUD_TASKS_QUEUE_PATH is set → enqueue Cloud Task
 * Dev/local path:   CLOUD_TASKS_QUEUE_PATH unset → setTimeout fallback with warning
 *
 * The Cloud Task handler should call:
 *   POST /api/v1/internal/provisional-chi  { userId, userTier }
 * (with INTERNAL_SERVICE_TOKEN for auth)
 */
function triggerProvisionalChi(userId, onboardingData, profileData, careerReport, userTier) {
  if (process.env.NODE_ENV === 'test') return;

  // Production path — Cloud Tasks (retryable, observable, crash-safe)
  if (CLOUD_TASKS_QUEUE_PATH) {
    const { CloudTasksClient } = require('@google-cloud/tasks');
    const tasksClient = new CloudTasksClient();

    const payload = JSON.stringify({ userId, userTier, source: 'provisional-chi' });
    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: `${process.env.API_BASE_URL || process.env.INTERNAL_REENGAGEMENT_URL}/api/v1/internal/provisional-chi`,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.INTERNAL_SERVICE_TOKEN || ''}`,
        },
        body: Buffer.from(payload).toString('base64'),
      },
      scheduleTime: {
        seconds: Math.floor(Date.now() / 1000) + 2, // 2-second delay matches old behaviour
      },
    };

    tasksClient.createTask({ parent: CLOUD_TASKS_QUEUE_PATH, task })
      .then(() => logger.info('[OnboardingService] Provisional CHI task enqueued', { userId }))
      .catch(err => {
        // Enqueue failure is non-fatal — fall through to in-process fallback
        logger.warn('[OnboardingService] Cloud Tasks enqueue failed — running in-process fallback', {
          userId, error: err.message,
        });
        _runProvisionalChiInProcess(userId, onboardingData, profileData, careerReport, userTier);
      });
    return;
  }

  // Dev/local fallback — setTimeout (per-instance only, not retryable)
  logger.debug('[OnboardingService] CLOUD_TASKS_QUEUE_PATH not set — using setTimeout fallback (dev only)', { userId });
  setTimeout(() => {
    _runProvisionalChiInProcess(userId, onboardingData, profileData, careerReport, userTier);
  }, 2000);
}

// Extracted so both paths above can reuse it without duplication
async function _runProvisionalChiInProcess(userId, onboardingData, profileData, careerReport, userTier) {
  try {
    await calculateProvisionalChi(userId, onboardingData, profileData, careerReport, userTier);
    logger.info('[OnboardingService] Provisional CHI complete (in-process)', { userId });
  } catch (err) {
    logger.error('[OnboardingService] Provisional CHI failed (non-fatal)', { userId, error: err.message });
  }
}

// ─── Step history + events ────────────────────────────────────────────────────

function appendStepHistory(step) {
  // Returns a partial object; callers must read existing stepHistory, append, and write back.
  // Since Supabase has no arrayUnion equivalent in a single upsert, the caller handles merging.
  return { _appendStep: { step, at: new Date().toISOString() } };
}

async function emitOnboardingEvent(userId, eventName, metadata = {}) {
  try {
    await conversionEventService.recordEvent(
      userId, eventName,
      { source: 'onboarding', ...metadata },
      `${userId}:${eventName}:${metadata.step || eventName}`
    );
  } catch (err) {
    logger.warn('[OnboardingService] Event emission failed (non-fatal)', { userId, eventName, error: err.message });
  }
}

// ─── Step history merge helper ────────────────────────────────────────────────
// Reads existing stepHistory from DB, appends new step, returns merged array.
// Used by callers that need to persist stepHistory correctly without arrayUnion.
async function mergeStepHistory(userId, newStep) {
  try {
    const { data, error } = await supabase
      .from('onboardingProgress')
      .select('stepHistory')
      .eq('id', userId)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') {
      logger.warn('[DB] mergeStepHistory read error', { userId, error: error.message });
    }
    const existing = data?.stepHistory || [];
    return [...existing, { step: newStep, at: new Date().toISOString() }];
  } catch (err) {
    logger.warn('[OnboardingService] mergeStepHistory failed — returning single-entry array', { userId, error: err.message });
    return [{ step: newStep, at: new Date().toISOString() }];
  }
}

// ─── Credits ──────────────────────────────────────────────────────────────────

/**
 * P4-05: deductCredits — idempotent credit deduction.
 *
 * Problem: if the AI call succeeds but saveIdempotencyKey() fails, a retry
 * would re-run the full function including another deductCredits() call —
 * double-charging the user.
 *
 * Solution: write a creditDeductionId to the user's credit ledger before
 * deducting. On retry, if the same creditDeductionId already exists, skip.
 *
 * @param {string} userId
 * @param {number} amount
 * @param {string|null} operationKey — idempotency key for this specific deduction
 *                                     (pass idempotencyKey from the caller; if null,
 *                                     falls back to last-write-wins for backwards compat)
 */
async function deductCredits(userId, amount, operationKey = null) {
  if (!amount || amount <= 0) return;
  try {
    const { data: userData, error: fetchErr } = await supabase
      .from('users')
      .select('aiCreditsRemaining, creditDeductionLog')
      .eq('id', userId)
      .maybeSingle();
    if (fetchErr && fetchErr.code !== 'PGRST116') {
      logger.error('[OnboardingService] deductCredits fetch failed', { userId, error: fetchErr.message });
      return;
    }
    if (!userData) return;

    // P4-05: idempotency guard — skip if this operation was already deducted
    if (operationKey) {
      const deductedOps = userData.creditDeductionLog || [];
      if (deductedOps.includes(operationKey)) {
        logger.info('[OnboardingService] Credit deduction skipped — already deducted', { userId, operationKey });
        return;
      }
    }

    const current = userData.aiCreditsRemaining ?? 0;
    const updatePayload = {
      aiCreditsRemaining: Math.max(0, current - amount),
      updatedAt:          new Date().toISOString(),
    };

    // P4-05: record this operation so retries are idempotent
    // Keep log capped at 50 entries to avoid unbounded growth
    if (operationKey) {
      const existing = userData.creditDeductionLog || [];
      updatePayload.creditDeductionLog = [...existing.slice(-49), operationKey];
    }

    const { error: updateErr } = await supabase
      .from('users')
      .upsert({ id: userId, ...updatePayload });
    if (updateErr) {
      logger.error('[OnboardingService] Credit deduction update failed', { userId, amount, error: updateErr.message });
    }
  } catch (err) {
    logger.error('[OnboardingService] Credit deduction failed', { userId, amount, error: err.message });
  }
}

// ─── AI context builder ───────────────────────────────────────────────────────
function calculateCareerWeights(careerHistory = []) {
  if (!careerHistory.length) return [];

  const totalMonths = careerHistory.reduce(
    (sum, r) => sum + (r.durationMonths || 0),
    0
  );

  return careerHistory.map((role, idx) => {
    const tenureRatio = totalMonths > 0
      ? (role.durationMonths || 0) / totalMonths
      : 0;

    const recencyBonus =
      idx === careerHistory.length - 1 ? 0.15 : 0;

    const currentBonus =
      role.isCurrent ? 0.2 : 0;

    const weight =
      Math.min(
        1,
        tenureRatio * 0.7 +
        recencyBonus +
        currentBonus
      );

    return {
      ...role,
      weight: Math.round(weight * 100) / 100
    };
  });
}


function buildAIContext(onboarding = {}, profile = {}) {
  const mergedSkills = mergeSkills(profile.skills || [], onboarding.skills || []);
  const country = profile.currentCountry || onboarding.personalDetails?.country || null;
  const city    = profile.currentCity    || onboarding.personalDetails?.city    || null;

  const careerHistory  = profile.careerHistory || [];
  const weightedHistory = calculateCareerWeights(careerHistory);

  const careerStabilityScore = (() => {
    if (careerHistory.length <= 1) return 1;
    const avgDuration =
      careerHistory.reduce((s, r) => s + (r.durationMonths || 0), 0)
      / careerHistory.length;

    if (avgDuration >= 36) return 1;
    if (avgDuration >= 18) return 0.7;
    if (avgDuration >= 9)  return 0.4;
    return 0.2;
  })();

  const promotionVelocity = (() => {
    if (careerHistory.length < 2) return 'steady';
    const durations = careerHistory.map(r => r.durationMonths || 0);
    const avg = durations.reduce((a,b)=>a+b,0)/durations.length;

    if (avg < 12) return 'rapid';
    if (avg < 24) return 'moderate';
    return 'steady';
  })();

  const impactSignal = (() => {
    const impactRegex = /\d+%|\$\d+|\d+\s?(users|clients|teams|projects)/i;
    // SPRINT-2 C2: prefer structured impactScore; fall back to regex scan for pre-migration data
    if (typeof onboarding.impactScore === 'number') return onboarding.impactScore;
    return (onboarding.experience || []).some(exp =>
      exp.responsibilities?.some(r => impactRegex.test(r))
    ) ? 1 : 0;
  })();

  const specializationType = (() => {
    if (!weightedHistory.length) return 'generalist';
    const dominant = weightedHistory.reduce(
      (max, r) => r.weight > (max.weight || 0) ? r : max,
      {}
    );
    return dominant.weight >= 0.6 ? 'specialist' : 'generalist';
  })();

  return {
    city,
    country,
    currentSalary:         profile.currentSalaryLPA         || null,
    expectedSalary:        profile.expectedSalaryLPA        || null,
    timeline:              profile.jobSearchTimeline        || null,
    careerIntent:          profile.expectedRoleIds          || [],
    // SPRINT-1 C1: targetRoleId is now the structured key for salary band lookups.
    // Falls back to expectedRoleIds[0] so CHI always has a resolvable role reference.
    // The old free-text targetRole field has been removed — it never matched Firestore doc IDs.
    targetRole:            onboarding.targetRoleId          || profile.targetRoleId || profile.expectedRoleIds?.[0] || null,
    // SPRINT-1 C5: pass seniority so CHI prompt can select the correct peer group
    selfDeclaredSeniority: profile.selfDeclaredSeniority    || onboarding.selfDeclaredSeniority || null,
    // SPRINT-2 C4: pass jobFunction so CHI marketAlignment uses the correct peer group
    jobFunction:           profile.jobFunction              || null,
    workAuthorisation:     onboarding.personalDetails?.workAuthorisation || null,
    linkedInUrl:           onboarding.personalDetails?.linkedInUrl       || null,
    portfolioUrl:          onboarding.personalDetails?.portfolioUrl      || null,

    weightedCareerHistory: weightedHistory,

    // 🔥 CHI Intelligence Signals
    careerStabilityScore,
    promotionVelocity,
    impactSignal,
    specializationType,

    skillsWithProficiency: mergedSkills,
    careerGaps:            onboarding.careerGaps || [],
    // SPRINT-2 C6: preferredWorkLocation drives region — overrides currentCity for international job seekers
    userRegion:            inferRegion(country, city, profile.preferredWorkLocation || onboarding.preferredWorkLocation || null),
    // SPRINT-2 C7: pass experience entries with type so AI can apply appropriate context
    // (volunteer/open_source entries are labelled so the AI doesn't treat them as employment gaps)
    experienceWithTypes:   (onboarding.experience || []).map(e => ({
      jobTitle:       e.jobTitle,
      company:        e.company,
      experienceType: e.experienceType || 'full_time',
      startDate:      e.startDate,
      endDate:        e.endDate,
      isCurrent:      e.isCurrent,
    })),
  };
}
// ─── Completion logic ─────────────────────────────────────────────────────────

function evaluateCompletion(progress = {}, profile = {}) {
  // Track A (manual): has education/experience AND a career report
  const trackA =
    !!(progress.education?.length || progress.experience?.length) &&
    !!progress.careerReport;

  // Track A-upload: used the CV upload path (wantsCv=true) AND has personal details
  // The upload path never generates a careerReport, so we check for cvResumeId +
  // personalDetails instead. This was the missing condition causing the redirect loop
  // for upload-path users — evaluateCompletion returned false, persistCompletionIfReady
  // never ran, onboardingCompleted was never written.
  const trackAUpload =
    !!progress.cvResumeId &&
    !!progress.personalDetails?.fullName;

  const trackB =
    !!(profile.careerHistory?.length) &&
    !!(profile.expectedRoleIds?.length);

  return { isComplete: trackA || trackAUpload, trackA, trackAUpload, trackB };
}

// GAP-04: Merge fragmented skills from three sources into canonicalSkills[]
// Priority: Track B (declared + proficiency) > AI topSkills (inferred) > Track A flat strings
// Fire-and-forget — never blocks onboarding completion.
async function mergeCanonicalSkills(userId, progressData, profileData) {
  try {
    // Source 1: Track B skills (name + proficiency, highest priority)
    const trackBSkills = (profileData.skills || []).map(s => ({
      name: s.name, proficiency: s.proficiency || 'intermediate', source: 'declared',
    }));

    // Source 2: AI-extracted topSkills from latest scored resume
    const { data: resumeRows, error: resumeErr } = await supabase
      .from('resumes')
      .select('topSkills')
      .eq('userId', userId)
      .eq('analysisStatus', 'completed')
      .eq('softDeleted', false)
      .order('scoredAt', { ascending: false })
      .limit(1);
    if (resumeErr) {
      logger.warn('[OnboardingService] mergeCanonicalSkills resume fetch error', { userId, error: resumeErr.message });
    }

    const topSkills = (!resumeRows || resumeRows.length === 0) ? [] :
      (resumeRows[0].topSkills || []).map(name => ({
        name, proficiency: 'intermediate', source: 'inferred',
      }));

    // Source 3: CV personal details skills (flat strings, lowest priority)
    const cvSkills = (progressData.personalDetails?.skills || []).map(name => ({
      name: typeof name === 'string' ? name : String(name?.name || ''),
      proficiency: 'intermediate', source: 'declared',
    }));

    // Deduplicate: first entry wins per lowercase name; upgrade inferred → declared if matched
    const seen = new Map();
    for (const s of [...trackBSkills, ...topSkills, ...cvSkills]) {
      const key = s.name.toLowerCase().trim();
      if (!key) continue;
      if (!seen.has(key)) {
        seen.set(key, s);
      } else if (s.source === 'declared' && seen.get(key).source === 'inferred') {
        seen.set(key, s); // upgrade source quality
      }
    }

    const canonicalSkills = [...seen.values()];
    const { error: upsertErr } = await supabase
      .from('userProfiles')
      .upsert({
        id: userId,
        canonicalSkills,
        canonicalSkillsUpdatedAt: new Date().toISOString(),
      });
    if (upsertErr) {
      logger.warn('[OnboardingService] canonicalSkills upsert failed', { userId, error: upsertErr.message });
    } else {
      logger.info('[OnboardingService] canonicalSkills merged', { userId, count: canonicalSkills.length });
    }
  } catch (err) {
    logger.warn('[OnboardingService] canonicalSkills merge failed (non-fatal)', { userId, error: err.message });
  }
}

async function persistCompletionIfReady(userId, progressData, profileData) {
  if (profileData.onboardingCompleted === true) return;
  const { isComplete } = evaluateCompletion(progressData, profileData);
  if (!isComplete) return;

  const now = new Date().toISOString();
  const cvResumeId = progressData.cvResumeId ?? null;

  // FIX: Write onboardingCompleted to BOTH collections:
  //   - userProfiles/{userId} — used by onboarding services internally
  //   - users/{userId}        — read by GET /users/me → frontend AuthProvider
  // Previously it was only written to userProfiles, so /users/me always
  // returned onboardingCompleted: false, causing an infinite redirect loop.
  const [progressStepHistory, profileStepHistory] = await Promise.all([
    mergeStepHistory(userId, 'onboarding_completed'),
    Promise.resolve(null), // profiles don't track stepHistory
  ]);

  await Promise.all([
    supabase.from('userProfiles').upsert({
      id:                    userId,
      onboardingCompleted:   true,
      onboardingCompletedAt: now,
      updatedAt:             now,
    }),
    supabase.from('users').upsert({
      id:                    userId,
      onboardingCompleted:   true,
      onboardingCompletedAt: now,
      updatedAt:             now,
      // FIX: If the user generated a CV during onboarding (Track A), mark resumeUploaded
      // on the users doc so the dashboard Resume Status card shows correctly.
      // progressData.cvResumeId is set by generateCV in onboarding.cv.service.js.
      ...(cvResumeId ? {
        resumeUploaded:  true,
        latestResumeId:  cvResumeId,
      } : {}),
    }),
    supabase.from('onboardingProgress').upsert({
      id:           userId,
      completedAt:  now,
      stepHistory:  progressStepHistory,
    }),
  ]);

  // GAP-06: reconcile Track A (date ranges) vs Track B (durationMonths) — take the max
  const trackBMonths = (profileData.careerHistory || [])
    .reduce((sum, r) => sum + (r.durationMonths || 0), 0);
  const totalMonths = Math.max(progressData.totalExperienceMonths || 0, trackBMonths);
  if (totalMonths > 0) {
    // Fire-and-forget — non-blocking
    supabase.from('userProfiles').upsert({
      id:                   userId,
      totalExperienceYears: +(totalMonths / 12).toFixed(1),
      updatedAt:            new Date().toISOString(),
    }).then(({ error }) => {
      if (error) logger.warn('[OnboardingService] totalExperienceYears write failed', { userId, error: error.message });
    });
  }

  // GAP-04: merge canonicalSkills fire-and-forget
  mergeCanonicalSkills(userId, progressData, profileData);

  const { trackA, trackB } = evaluateCompletion(progressData, profileData);
  emitOnboardingEvent(userId, 'onboarding_completed', { trackA, trackB });
  logger.info('[OnboardingService] Onboarding marked complete', { userId });
}

// ─── FIX G-12: Date validation ────────────────────────────────────────────────

function validateExperienceDates(experience) {
  if (!Array.isArray(experience) || !experience.length) return;
  const now       = new Date();
  const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentRoles = [];

  for (let i = 0; i < experience.length; i++) {
    const exp   = experience[i];
    const label = `Experience entry ${i + 1} (${exp.jobTitle || 'untitled'} at ${exp.company || 'unknown'})`;
    const { startDate: start, endDate: end, isCurrent } = exp;
    const isCur = Boolean(isCurrent);

    if (start && start > currentYM) throw new AppError(`${label}: startDate "${start}" cannot be in the future.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (end   && end   > currentYM) throw new AppError(`${label}: endDate "${end}" cannot be in the future.`,     400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (start && end   && end < start) throw new AppError(`${label}: endDate "${end}" cannot be before startDate "${start}".`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (isCur && end) throw new AppError(`${label}: cannot have both isCurrent=true and an endDate.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (isCur) currentRoles.push(i);
  }
  if (currentRoles.length > 1) throw new AppError(`Only one experience entry can have isCurrent=true. Found ${currentRoles.length} at indices: ${currentRoles.join(', ')}.`, 400, { indices: currentRoles }, ErrorCodes.VALIDATION_ERROR);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0 — SAVE CONSENT  (PROMPT-2)
//
// Must be called before any personal data is collected (i.e. before Step 1).
// Stores an explicit, timestamped consent record in:
//   users/{userId}        — consentGrantedAt, consentVersion
//   userProfiles/{userId} — consentGrantedAt, consentVersion (for CHI / CV pipeline)
//   onboardingProgress/{userId} — step marker for progress tracking
//
// GDPR Art. 6(1)(a) / UAE PDPL Art. 8 compliance:
//   - consentGrantedAt: exact ISO timestamp of the user action
//   - consentVersion:   links to the T&C / Privacy Policy version shown
//   - consentSource:    'onboarding_step_0' — audit trail of where consent was given
//
// Idempotent: calling again with a newer consentVersion updates the record.
// Calling again with the same version is a no-op (returns existing record).
// ─────────────────────────────────────────────────────────────────────────────


module.exports = {
  validateAchievements,
  callAnthropicWithRetry,
  stripJson,
  stripHtml,
  sanitiseInput,
  validateUrl,
  validateYearOfGraduation,
  validateAndSanitiseResponsibilities,
  checkIdempotencyKey,
  saveIdempotencyKey,
  mergeSkills,
  computeExperienceMonths,
  inferRegion,
  scheduleReengagementJob,
  triggerResumeScoring,
  triggerProvisionalChi,
  _runProvisionalChiInProcess,
  appendStepHistory,
  mergeStepHistory,
  emitOnboardingEvent,
  deductCredits,
  calculateCareerWeights,
  buildAIContext,
  evaluateCompletion,
  mergeCanonicalSkills,
  persistCompletionIfReady,
  validateExperienceDates,
  MODEL,
  IDEMPOTENCY_TTL_MS,
  URL_TTL_MS,
  CHI_TREND_THRESHOLD,
  VALID_SENIORITY,
  EXPERIENCE_TYPE_WEIGHTS,
  VALID_EXPERIENCE_TYPES,
};
