'use strict';

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const { logAIInteraction } = require('../../infrastructure/aiLogger');
const { resolveExpectedRoleIdsFromTitle } = require('../../shared/utils/roleCatalog');
// WP-PRO-12B: reuse the existing canonical Professional Profile read path
// (no new repository, no duplicated logic) as a fallback data source when
// onboarding_progress hasn't yet been synchronized — see
// WP-PRO-12B-I for the root cause (evaluateCompletion()'s gate can't be
// satisfied by the Resume-Upload-only journey).
const { getProfessionalProfile } = require('../../domain/professionalProfile/professionalProfile.repository');
// WP-SPCE-03A: the Smart Profile Completion Engine is now the single
// source of truth for the "is this profile ready for a Career Report"
// rule, replacing the two manual `if (!x.length) throw` checks that used
// to duplicate it inline here. See the "WP-SPCE-03A" comment further down
// for the full mapping and WP-SPCE-03A_Business_Rule_Mapping.md /
// WP-SPCE-03A_OutputDiff_Report.md for the equivalence proof.
const { evaluate } = require('../../domain/profileReadiness/readinessEngine');
const { CAPABILITY_IDS } = require('../../domain/profileReadiness/capabilityRegistry');

const {
  MODEL,
  callAnthropicWithRetry,
  stripJson,
  checkIdempotencyKey,
  saveIdempotencyKey,
  deductCredits,
  emitOnboardingEvent,
  mergeStepHistory,
  buildAIContext,
  triggerProvisionalChi,
  persistCompletionIfReady,
} = require('./onboarding.helpers');

const TABLE_ONBOARDING_PROGRESS = 'onboarding_progress';
const TABLE_USER_PROFILES = 'user_profiles';

const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
};

function buildCareerReportPrompt(region) {
  return `You are a senior career counsellor with 20 years of experience in ${region}'s job market.

Return ONLY valid JSON.

{
  "overallAssessment": "...",
  "educationGaps": [],
  "experienceGaps": [],
  "skillRecommendations": [],
  "careerOpportunities": [],
  "nextSteps": [],
  "marketInsight": "..."
}`;
}

async function generateCareerReport(
  userId,
  creditCost,
  idempotencyKey = null,
  userTier = 'free'
) {
  if (!userId) {
    throw new AppError(
      'userId is required',
      ErrorCodes.VALIDATION_ERROR,
      400,
      {}
    );
  }

  const cached = await checkIdempotencyKey(
    userId,
    'careerReport',
    idempotencyKey
  );
  if (cached) return cached;

  const [progressRes, profileRes] = await Promise.all([
    supabase
      .from(TABLE_ONBOARDING_PROGRESS)
      .select('education, experience, step, updated_at')
      .eq('id', userId)
      .maybeSingle(),

    supabase
      .from(TABLE_USER_PROFILES)
      .select('expected_role_ids, target_role, current_job_title, current_city, skills')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (progressRes.error) throw progressRes.error;
  if (profileRes.error) throw profileRes.error;

  const progress = progressRes.data;
  const profile = profileRes.data || {};

  if (!progress) {
    throw new AppError('No onboarding data found', ErrorCodes.NOT_FOUND, 404, {});
  }

  // WP-DIAG-01 TEMP — diagnostic-only, remove alongside the other
  // [WP-DIAG] log calls in this file once the investigation is closed.
  logger.info('[WP-DIAG] generateCareerReport read onboarding_progress', {
    userId,
    educationCount:  Array.isArray(progress.education)  ? progress.education.length  : 0,
    experienceCount: Array.isArray(progress.experience) ? progress.experience.length : 0,
    step:            progress.step ?? null,
    updatedAt:       progress.updated_at ?? null,
  });

  // WP-PRO-12B: canonical fallback. onboarding_progress is left as-is and
  // used unchanged whenever it already has synchronized data (no behaviour
  // change for already-synced users). Only a field that's missing from
  // onboarding_progress falls back to the canonical Professional Profile,
  // via the existing getProfessionalProfile() repository read — no new
  // repository, no duplicated persistence logic, evaluateCompletion() and
  // buildProfileSyncPatch() are untouched.
  let effectiveEducation = Array.isArray(progress.education) ? progress.education : [];
  let effectiveExperience = Array.isArray(progress.experience) ? progress.experience : [];

  if (!effectiveEducation.length || !effectiveExperience.length) {
    const professionalProfile = await getProfessionalProfile(userId);

    if (!effectiveEducation.length && professionalProfile?.education?.length) {
      effectiveEducation = professionalProfile.education;
    }
    if (!effectiveExperience.length && professionalProfile?.experience?.length) {
      effectiveExperience = professionalProfile.experience;
    }

    // WP-DIAG-01 TEMP
    logger.info('[WP-DIAG] generateCareerReport canonical fallback consulted', {
      userId,
      onboardingProgressEducationCount:  Array.isArray(progress.education)  ? progress.education.length  : 0,
      onboardingProgressExperienceCount: Array.isArray(progress.experience) ? progress.experience.length : 0,
      effectiveEducationCount:  effectiveEducation.length,
      effectiveExperienceCount: effectiveExperience.length,
    });
  }

  // WP-SPCE-03A: education/experience readiness gate, delegated to the
  // Capability Registry's `career_report` definition instead of a manual
  // `if (!x.length && !y.length) throw` check.
  //
  // This MUST still run — and still short-circuit — before role
  // resolution below: the pre-migration code threw this 422 before ever
  // reaching the `resolveExpectedRoleIdsFromTitle()` call or its DB write,
  // so a profile that fails here never triggered that side effect. Calling
  // evaluate() once with `expectedRoleIds` fixed at `[]` reproduces
  // exactly that ordering — the OR-group's (education/experience) result
  // doesn't depend on the AND-group's other leaf, so pinning that leaf to
  // "missing" here doesn't change whether `missingFields` reports
  // 'education'/'experience'; it only guarantees this probe can never
  // spuriously report readiness before role resolution has even run. See
  // WP-SPCE-03A_OutputDiff_Report.md.
  const eduExpProbe = evaluate(CAPABILITY_IDS.CAREER_REPORT, {
    education: effectiveEducation,
    experience: effectiveExperience,
    careerGoals: { expectedRoleIds: [] },
  });

  if (
    eduExpProbe.missingFields.includes('education') ||
    eduExpProbe.missingFields.includes('experience')
  ) {
    // WP-DIAG-01 TEMP — same message/fields as the pre-migration check
    // this replaces.
    logger.warn('[WP-DIAG] generateCareerReport 422 validation triggered', {
      userId,
      reason: 'education and experience are both empty in onboarding_progress and the canonical Professional Profile',
    });
    throw new AppError(
      'Add education or experience first',
      ErrorCodes.VALIDATION_ERROR,
      422,
      {}
    );
  }

  let expectedRoleIds = profile.expected_role_ids || [];

  // Career Role Resolution (WP-PRO-10B, Defect 2): the canonical write path
  // (professionalProfile.repository.js) now resolves `target_role` into
  // `expected_role_ids` at save time for all future writes. This fallback
  // self-heals profiles that were written before that fix existed — it
  // resolves the same free-text `target_role` on read and persists the
  // result back onto the same `expected_role_ids` column (no second
  // storage location, no conflicting source), so this only runs once per
  // profile going forward.
  //
  // BUGFIX (WP-PRO-12C): `target_role` is only ever populated by the
  // Guided Builder / Career Goals form — professionalProfile.normalizer
  // .js#normalizeResumeUpload never sets careerGoals, so a user who
  // onboarded purely via Resume Upload has `target_role: null` and
  // `expected_role_ids: []` forever, even though
  // `professional_onboarding_complete` is true (evaluateCompletion()'s
  // trackAUpload doesn't require a role at all). This self-heal therefore
  // never ran for them and Career Report generation always 422'd with
  // "Target role required".
  //
  // BUGFIX (WP-PRO-12D): `current_job_title` alone isn't always enough
  // either — it's sourced from the resume's free-text header/headline
  // (HireRiseResume.core.title), which many resumes simply don't have, so
  // it can be null right alongside `target_role`. The most reliably
  // populated title for anyone with real work history is the job title on
  // their most recent experience entry (professionalProfile.normalizer
  // .js#normalizeExperience always captures `title` per entry when
  // present in the source data). Candidates are tried in order of how
  // deliberately/explicitly the user provided them — an explicit target
  // role beats an inferred current title, which beats an inferred past
  // job title — and the first one that resolves to a catalog role wins.
  const roleResolutionCandidates = [
    profile.target_role,
    profile.current_job_title,
    effectiveExperience[0]?.title,
  ].filter((title) => typeof title === 'string' && title.trim().length > 0);

  if (!expectedRoleIds.length && roleResolutionCandidates.length) {
    for (const candidateTitle of roleResolutionCandidates) {
      const resolvedRoleIds = await resolveExpectedRoleIdsFromTitle(candidateTitle);

      if (resolvedRoleIds.length) {
        expectedRoleIds = resolvedRoleIds;

        const { error: roleSyncError } = await supabase
          .from(TABLE_USER_PROFILES)
          .update({
            expected_role_ids: resolvedRoleIds,
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId);

        if (roleSyncError) {
          logger.warn('[CareerReport] failed to persist resolved expected_role_ids', {
            userId,
            error: roleSyncError.message,
          });
        }

        break;
      }
    }

    // WP-DIAG-01 TEMP — surfaces exactly which titles were attempted and
    // why none resolved.
    if (!expectedRoleIds.length) {
      logger.warn('[WP-DIAG] generateCareerReport role resolution exhausted all candidates', {
        userId,
        candidatesTried: roleResolutionCandidates,
      });
    }
  }

  // BUGFIX (WP-PRO-12E): Career Report must not hard-depend on a
  // successful `roles` catalog match. Investigation (WP-PRO-12D) confirmed
  // the catalog is a small, necessarily-incomplete fixed list — in this
  // environment, exactly 5 generic tech-role rows — so any real-world
  // title outside it ("General Manager", "Director of Marketing", etc.)
  // would 422 with "Target role required" forever, no matter how good the
  // free-text candidate is, even though the user plainly told us their
  // target role. `expected_role_ids` is still opportunistically resolved
  // and persisted above (the loop just before this) because OTHER
  // capabilities in the registry (Job Matching, analytics) genuinely need
  // a normalized catalog id — but Career Report generation itself only
  // ever needed a role NAME to put in the AI prompt, never the id. So this
  // deliberately does NOT delegate to readinessEngine.evaluate() for the
  // role leaf the way the education/experience gate above still does:
  // that shared `career_report` registry definition encodes "must have a
  // resolved expectedRoleIds", which is a stricter rule than what this
  // function actually needs. The only case Career Report genuinely cannot
  // proceed without more input is when there is NO title anywhere at all —
  // not resolved, not free-text.
  const targetRoleForPrompt = roleResolutionCandidates[0] || null;

  if (!expectedRoleIds.length && !targetRoleForPrompt) {
    throw new AppError(
      'Target role required',
      ErrorCodes.VALIDATION_ERROR,
      422,
      {}
    );
  }

  const aiContext = buildAIContext(progress, profile);

  // BUGFIX (WP-PRO-12E): buildAIContext()'s own targetRole resolution
  // (onboarding.helpers.js#buildAIContext) reads a `target_role_id` field
  // that is never populated anywhere in this codebase — its only working
  // fallback is `profile.expected_role_ids?.[0]`, a raw catalog UUID, which
  // is not a legible role name for an AI prompt. Override with the best
  // human-readable title we already resolved above (free-text takes
  // priority here — it's always a real name, where the catalog id is only
  // ever a UUID the shared helper has no way to turn back into a name).
  if (targetRoleForPrompt) {
    aiContext.targetRole = targetRoleForPrompt;
  }

  const userPrompt = JSON.stringify({
    education: effectiveEducation,
    experience: effectiveExperience,
    context: aiContext,
  });

  let report;
  const startMs = Date.now();
  const now = new Date().toISOString();

  try {
    const anthropic = getAnthropicClient();
    if (!anthropic) {
      throw new Error('Anthropic client unavailable');
    }

    const response = await callAnthropicWithRetry(
      () =>
        anthropic.messages.create({
          model: MODEL,
          max_tokens: 2048,
          system: buildCareerReportPrompt(
            aiContext.userRegion || 'India'
          ),
          messages: [{ role: 'user', content: userPrompt }],
        }),
      { module: 'careerReport', userId }
    );

    const raw = response.content?.[0]?.text || '{}';
    report = JSON.parse(stripJson(raw));

    logAIInteraction({
      module: 'careerReport',
      latencyMs: Date.now() - startMs,
      status: 'success',
      userId,
    });

  } catch (err) {
    logAIInteraction({
      module: 'careerReport',
      latencyMs: Date.now() - startMs,
      status: 'error',
      error: err,
      userId,
    });

    logger.error('[CareerReport] generation failed', {
      userId,
      err: err.message,
    });

    throw new AppError('AI generation failed', ErrorCodes.SERVICE_UNAVAILABLE, 502, {});
  }

  const stepHistory = await mergeStepHistory(
    userId,
    'career_report_generated'
  );

  const { error: upsertError } = await supabase
    .from(TABLE_ONBOARDING_PROGRESS)
    .upsert({
      id: userId,
      step: 'career_report_generated',
      career_report: report,
      step_history: stepHistory,
      updated_at: now,
    });

  if (upsertError) throw upsertError;

  const [updatedProgress, updatedProfile] = await Promise.all([
    supabase
      .from(TABLE_ONBOARDING_PROGRESS)
      .select('*')
      .eq('id', userId)
      .maybeSingle(),

    supabase
      .from(TABLE_USER_PROFILES)
      .select('*')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  await persistCompletionIfReady(
    userId,
    updatedProgress.data || {},
    updatedProfile.data || {}
  );

  triggerProvisionalChi(
    userId,
    progress,
    profile,
    report,
    userTier
  );

  emitOnboardingEvent(userId, 'onboarding_step_completed', {
    step: 'career_report_generated',
  });

  const result = {
    userId,
    step: 'career_report_generated',
    careerReport: report,
  };

  await saveIdempotencyKey(
    userId,
    'careerReport',
    idempotencyKey,
    result
  );

  return result;
}

async function getCareerReportStatus(userId) {
  if (!userId) {
    throw new AppError(
      'userId is required',
      ErrorCodes.VALIDATION_ERROR,
      400,
      {}
    );
  }

  const { data, error } = await supabase
    .from(TABLE_ONBOARDING_PROGRESS)
    .select('career_report, ai_failures')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { status: 'pending' };

  if (data.career_report) {
    return { status: 'complete' };
  }

  const failure = data.ai_failures?.slice(-1)?.[0];
  if (failure) {
    return {
      status: 'failed',
      retryable: true,
      retryAfterSeconds: 30,
    };
  }

  return { status: 'pending' };
}

module.exports = {
  buildCareerReportPrompt,
  generateCareerReport,
  getCareerReportStatus,
};