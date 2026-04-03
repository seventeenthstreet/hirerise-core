'use strict';

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const { logAIInteraction } = require('../../infrastructure/aiLogger');

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
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
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
      .select('expected_role_ids, current_city, skills')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (progressRes.error) throw progressRes.error;
  if (profileRes.error) throw profileRes.error;

  const progress = progressRes.data;
  const profile = profileRes.data || {};

  if (!progress) {
    throw new AppError('No onboarding data found', 404);
  }

  if (!progress.education?.length && !progress.experience?.length) {
    throw new AppError('Add education or experience first', 422);
  }

  const expectedRoleIds = profile.expected_role_ids || [];
  if (!expectedRoleIds.length) {
    throw new AppError('Target role required', 422);
  }

  const aiContext = buildAIContext(progress, profile);

  const userPrompt = JSON.stringify({
    education: progress.education || [],
    experience: progress.experience || [],
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

    if (creditCost > 0) {
      await deductCredits(userId, creditCost, idempotencyKey);
    }

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

    throw new AppError('AI generation failed', 502);
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
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
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