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
 *
 * WP-PRO-06B FIX (integrity remediation — see WP-PRO-06A §1/§5):
 *   TABLE_USERS previously aliased to 'user_profiles', so the write that
 *   believed it was updating the `users` table was silently updating
 *   `user_profiles` a second time. `users.onboarding_completed` and
 *   `users.professional_onboarding_complete` — the two columns every auth
 *   gate (`GET /me`, `AuthGuard`, `GET /app-entry`'s ETag freshness check)
 *   actually reads — were therefore never written by any code path.
 *   TABLE_USERS now correctly points at 'users', and
 *   persistCompletionIfReady() issues a genuine third write against it.
 *   `onboarding_progress.step`/`completed` are also now set on completion so
 *   the Progress API's fallback completion check (WP-PRO-06A §8, finding #5)
 *   no longer depends solely on the deprecated RPC to populate them.
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
// WP-PRO-10E FIX: Professional Onboarding persists the user-approved profile
// into `user_profiles` (professionalProfile.repository.js), but Career
// Report validates `onboarding_progress.education` / `.experience`
// (onboarding.careerReport.service.js) — no code path ever copied the
// former into the latter, so a first Career Report call after Completion
// failed with 422 "Add education or experience first" until a second,
// unrelated write (e.g. Guided Builder) happened to populate
// onboarding_progress directly. persistCompletionIfReady() is the single
// existing orchestration point for Professional Onboarding Completion
// (called from the controller, careerReport/linkedin/intake services), so
// the missing sync is added there — reusing the existing canonical read
// path rather than re-deriving education/experience from raw columns.
const { getProfessionalProfile } = require('../../domain/professionalProfile/professionalProfile.repository');
// WP-SPCE-03B: the Smart Profile Completion Engine is now the single
// source of truth for Track B's readiness rule inside evaluateCompletion()
// below, replacing the inline `careerDataExists && expected_role_ids.length`
// calculation with a call to the SAME, already-shipped, unmodified
// `professional_onboarding_completion` registry entry that
// onboarding.careerReport.service.js's `career_report` capability already
// uses (WP-SPCE-03A precedent). Track A and Track A Upload are NOT
// migrated — see WP-SPCE-03B-PRE §6/§7 for the evidenced reasons
// (career_report is a process-completion flag, not a profile-data fact;
// cv_resume_id/personal_details have no non-circular canonical-schema
// equivalent). No registry change, no new capability, no new I/O.
const { evaluate } = require('../../domain/profileReadiness/readinessEngine');
const { CAPABILITY_IDS } = require('../../domain/profileReadiness/capabilityRegistry');

const TABLE_PROGRESS   = 'onboarding_progress';
// WP-PRO-06B FIX: was 'user_profiles' — see WP-PRO-06A §1/§5. TABLE_USERS
// must point at the actual `users` table, since that is what every auth
// gate (GET /me, AuthGuard, GET /app-entry's freshness check) reads.
const TABLE_USERS      = 'users';
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

  // Track A-Upload: CV uploaded + a name on file.
  // WP-AV-03C FIX: `profile.display_name` (the canonical field written by
  // Resume Upload's normalization path — see professionalProfile
  // .normalizer.js / saveProfessionalProfileSections) is now accepted
  // alongside the two legacy `progress` fields this check already read.
  // Additive only — neither legacy field is removed or altered, so
  // Guided Builder and any pre-existing legacy manual-onboarding rows
  // that rely on `personal_details.full_name` / `full_name` are unaffected.
  const trackAUpload =
    Boolean(progress.cv_resume_id) &&
    Boolean(
      profile.display_name ||
      progress.personal_details?.full_name ||
      progress.full_name
    );

  // Track B (WP-PRO-10G FIX, refined WP-PRO-10GA): approved Professional
  // Profile has career data AND an expected role — same business intent
  // as the original rule, only the obsolete half of it replaced.
  //
  // Originally this checked `profile.career_history?.length &&
  // profile.expected_role_ids?.length`. Repository evidence (WP-PRO-10F)
  // showed `career_history` is never written by any code path in the
  // current architecture — `professionalProfile.repository.js`, the sole
  // write path for both product-approved entry methods (Resume Upload and
  // Guided Builder; see professional-onboarding.definition.js's header:
  // "one of several independently-completable tracks that all converge
  // into the same normalized Professional Profile"), writes `experience`
  // as a dedicated column and `education` inside the `professional_profile`
  // jsonb blob instead. `career_history` was a column belonging to an
  // older persistence model that this repository already moved off of, so
  // only that half of the rule is replaced below.
  //
  // `expected_role_ids` is NOT replaced or dropped (WP-PRO-10GA): unlike
  // `career_history`, repository evidence shows it is very much still
  // part of the current architecture —
  //   - written by this same write path, `professionalProfile.repository
  //     .js#saveProfessionalProfileSections` (Career Goals section,
  //     lines ~192-209), including a self-healing resolution from
  //     free-text `target_role` when no explicit role id was supplied;
  //   - read and required (with its own independent self-heal fallback)
  //     by `onboarding.careerReport.service.js#generateCareerReport`
  //     (its separate "Target role required" 422, distinct from the
  //     education/experience 422 WP-PRO-10E/10F/10G address);
  //   - read by `onboarding.analytics.service.js` and `roles.service.js`.
  // So the original "career data AND expected role" business rule is
  // preserved exactly — only the obsolete `career_history` signal was
  // swapped for the fields the current write path actually populates.
  //
  // Read directly off the `profile` row already passed in — every
  // existing call site (onboarding.controller.js, careerReport/linkedin/
  // intake services) already fetches `user_profiles` with `select('*')`,
  // so `experience`, `professional_profile`, and `expected_role_ids` are
  // all already present here. No new I/O is introduced, and
  // evaluateCompletion() stays the same synchronous, pure function
  // professional-onboarding.progression.js calls directly (unawaited)
  // from computeStepStates().
  const professionalProfileBlob =
    (profile.professional_profile && typeof profile.professional_profile === 'object')
      ? profile.professional_profile
      : {};

  // WP-SPCE-03B: SPCE-backed Track B evaluation. The canonical-shape
  // mapping below uses exactly the same three source reads the pre-
  // migration inline calculation used — profile.experience,
  // professionalProfileBlob.education, profile.expected_role_ids — no new
  // field reads and no new I/O are introduced. This is a call-site swap
  // only; capabilityRegistry.js's `professional_onboarding_completion`
  // definition itself is unmodified (still `(experience OR education) AND
  // careerGoals.expectedRoleIds`, identical to the rule this replaces).
  // See documents/WP-SPCE/WP-SPCE-03B_TrackB_Migration_Deliverables.md
  // for the fixture-by-fixture equivalence proof, and
  // __tests__/onboarding.helpers.spceTrackBMigration.test.js for the
  // executable output-diff regression suite.
  const trackBReadiness = evaluate(CAPABILITY_IDS.PROFESSIONAL_ONBOARDING_COMPLETION, {
    experience: profile.experience,
    education: professionalProfileBlob.education,
    careerGoals: { expectedRoleIds: profile.expected_role_ids },
  });

  const trackB = trackBReadiness.isReady;

  return {
    isComplete: trackA || trackAUpload || trackB,
    trackA,
    trackAUpload,
    trackB,
  };
}

// WP-PRO-10E FIX: Synchronize the approved Professional Profile's
// education/experience into onboarding_progress at Completion time.
//
// Reuses the existing canonical read path (professionalProfile.repository
// .js#getProfessionalProfile) rather than re-deriving education/experience
// from raw user_profiles columns — this is the same composed shape the
// Guided Builder pre-fill already relies on, so there is exactly one
// place that knows how to assemble a Professional Profile.
//
// Idempotency (WP-PRO-10E Step 5): only ever fills a currently-empty
// array. If onboarding_progress already has entries (from this sync on a
// prior Completion attempt, or from a direct write such as Guided
// Builder), those entries are left untouched — never overwritten, and
// never re-appended to (no duplication). If the Professional Profile
// itself has no education/experience to offer, nothing is written for
// that field and the pre-existing 422 behaviour in the Career Report
// service is preserved unchanged.
async function buildProfileSyncPatch(userId, progressData) {
  // WP-DIAG-01 TEMP — diagnostic-only, remove alongside the other
  // [WP-DIAG] log calls in this file once the investigation is closed.
  logger.info('[WP-DIAG] buildProfileSyncPatch entered', {
    userId,
    educationCount:  Array.isArray(progressData?.education)  ? progressData.education.length  : 0,
    experienceCount: Array.isArray(progressData?.experience) ? progressData.experience.length : 0,
  });

  let professionalProfile;
  try {
    professionalProfile = await getProfessionalProfile(userId);
  } catch (err) {
    // Fail the whole Completion, per Step 6 — do not persist completion
    // flags on top of a partial/failed sync.
    logger.error('[Helpers] failed to read Professional Profile for completion sync', {
      userId,
      error: err.message,
    });
    throw new AppError(
      'Failed to persist onboarding completion',
      500,
      { userId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  const patch = {};

  const hasExistingEducation  = Array.isArray(progressData?.education) && progressData.education.length > 0;
  const approvedEducation     = Array.isArray(professionalProfile?.education) ? professionalProfile.education : [];
  if (!hasExistingEducation && approvedEducation.length > 0) {
    patch.education = approvedEducation;
  }

  const hasExistingExperience = Array.isArray(progressData?.experience) && progressData.experience.length > 0;
  const approvedExperience    = Array.isArray(professionalProfile?.experience) ? professionalProfile.experience : [];
  if (!hasExistingExperience && approvedExperience.length > 0) {
    patch.experience = approvedExperience;
  }

  // WP-DIAG-01 TEMP — keys only, never the profile contents themselves.
  logger.info('[WP-DIAG] buildProfileSyncPatch generated patch', {
    userId,
    patchKeys:            Object.keys(patch),
    expectedRoleCount:    Array.isArray(professionalProfile?.expectedRoleIds) ? professionalProfile.expectedRoleIds.length : 0,
  });

  return patch;
}

async function persistCompletionIfReady(userId, progressData, profileData) {
  // WP-DIAG-01 TEMP — diagnostic-only, remove alongside the other
  // [WP-DIAG] log calls in this file once the investigation is closed.
  logger.info('[WP-DIAG] persistCompletionIfReady entered', { userId });

  // WP-PRO-12A-2 FIX: every path below now returns a structured completion
  // result instead of `undefined`, so callers (completeOnboarding()) can
  // distinguish "already completed" / "newly completed" / "not yet
  // complete" and populate the declared CompleteOnboardingResponse
  // contract. This does not add any new I/O or change which branch runs —
  // it only attaches a return value to branches that already existed.
  if (profileData?.onboarding_completed === true) {
    // WP-DIAG-01 TEMP
    logger.info('[WP-DIAG] persistCompletionIfReady EARLY RETURN', {
      userId,
      reason: 'profileData.onboarding_completed already true',
    });

    // Track-level metadata is still useful to the caller even though this
    // is a no-op write path, and evaluateCompletion() is the same pure,
    // synchronous, already-fetched-data function used everywhere else —
    // computing it here introduces no new I/O and does not change
    // evaluateCompletion() itself.
    const completionInfo = evaluateCompletion(progressData, profileData);
    return {
      isComplete:       true,
      alreadyCompleted: true,
      trackA:           completionInfo.trackA,
      trackAUpload:     completionInfo.trackAUpload,
      trackB:           completionInfo.trackB,
    };
  }

  const completion = evaluateCompletion(progressData, profileData);

  // WP-DIAG-01 TEMP
  logger.info('[WP-DIAG] evaluateCompletion result', {
    userId,
    trackA:       completion.trackA,
    trackAUpload: completion.trackAUpload,
    trackB:       completion.trackB,
    isComplete:   completion.isComplete,
  });

  if (!completion.isComplete) {
    // WP-DIAG-01 TEMP
    logger.info('[WP-DIAG] persistCompletionIfReady EARLY RETURN', {
      userId,
      reason:           'evaluateCompletion().isComplete === false',
      completionResult: completion,
    });
    return {
      isComplete:       false,
      alreadyCompleted: false,
      trackA:           completion.trackA,
      trackAUpload:     completion.trackAUpload,
      trackB:           completion.trackB,
    };
  }

  const now         = new Date().toISOString();
  const stepHistory = await mergeStepHistory(userId, 'onboarding_completed');
  const profileSyncPatch = await buildProfileSyncPatch(userId, progressData);

  // WP-DIAG-01 TEMP
  logger.info('[WP-DIAG] starting users update', { userId });

  const writes = await Promise.all([
    // user_profiles — unchanged; this is the write GET /app-entry's redirect
    // decision (fetchUserProfile) already correctly reads (WP-PRO-06A §3).
    supabase.from(TABLE_PROFILES).update({
      onboarding_completed:    true,
      onboarding_completed_at: now,
      updated_at:              now,
    }).eq('id', userId),

    // WP-PRO-06B FIX: this is now a genuine write to the `users` table
    // (TABLE_USERS === 'users'), not a second write to user_profiles under
    // a mis-aliased name. professional_onboarding_complete is set here
    // because this module (src/modules/onboarding) is the Professional
    // Onboarding path — it is the sole owner of this flag per WP-PRO-06A §6.
    // This is also what GET /app-entry's ETag freshness check reads, so
    // fixing this write resolves the false-304 caching issue (§7) as a
    // side effect, without any change needed to appEntry.route.js.
    supabase.from(TABLE_USERS).update({
      onboarding_completed:              true,
      professional_onboarding_complete:  true,
      updated_at:                        now,
      ...(progressData?.cv_resume_id
        ? { resume_uploaded: true, latest_resume_id: progressData.cv_resume_id }
        : {}),
    }).eq('id', userId)
      // WP-DIAG-01 TEMP — logs the resolved write outcome without altering
      // the value passed through to `writes` below.
      .then((result) => {
        logger.info('[WP-DIAG] users update finished', {
          userId,
          success:                          !result?.error,
          error:                            result?.error?.message ?? null,
          affectedRows:                     Array.isArray(result?.data) ? result.data.length : (result?.data ? 1 : 0),
          professional_onboarding_complete: true,
          onboarding_completed:             true,
        });
        return result;
      }),

    // WP-PRO-06B FIX: also set step/completed so the Progress API's
    // fallback completion check (onboarding.analytics.service.js
    // getProgress(): `progress.step === 'completed'`) is satisfied by the
    // canonical path itself, not only by the deprecated RPC
    // (WP-PRO-06A §8, finding #5).
    (() => {
      // WP-DIAG-01 TEMP
      logger.info('[WP-DIAG] starting onboarding_progress update', { userId });
      return supabase.from(TABLE_PROGRESS).update({
        completed_at: now,
        step:         'completed',
        completed:    true,
        step_history: stepHistory,
        updated_at:   now,
        // WP-PRO-10E FIX: carries {education, experience} only when the
        // approved Professional Profile has entries onboarding_progress is
        // currently missing (see buildProfileSyncPatch). All other fields on
        // this row — including any education/experience already present —
        // are left untouched by this spread.
        ...profileSyncPatch,
      }).eq('user_id', userId)
        // WP-DIAG-01 TEMP
        .then((result) => {
          logger.info('[WP-DIAG] onboarding_progress update finished', {
            userId,
            success:         !result?.error,
            error:           result?.error?.message ?? null,
            affectedRows:    Array.isArray(result?.data) ? result.data.length : (result?.data ? 1 : 0),
            educationCount:  Array.isArray(profileSyncPatch.education)  ? profileSyncPatch.education.length  : 0,
            experienceCount: Array.isArray(profileSyncPatch.experience) ? profileSyncPatch.experience.length : 0,
          });
          return result;
        });
    })(),
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

  return {
    isComplete:       true,
    alreadyCompleted: false,
    trackA:           completion.trackA,
    trackAUpload:     completion.trackAUpload,
    trackB:           completion.trackB,
  };
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
      p_amount:  Math.trunc(Number(creditCost)),
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