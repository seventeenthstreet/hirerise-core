'use strict';

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const { logAIInteraction } = require('../../infrastructure/aiLogger');

let careerGraph = null;
try { careerGraph = require('../careerGraph/CareerGraph'); } catch (_) {}

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

const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
};

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SERVICE
// ─────────────────────────────────────────────────────────────────────────────

async function generateCareerReport(userId, creditCost, idempotencyKey = null, userTier = 'free') {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const cached = await checkIdempotencyKey(userId, 'careerReport', idempotencyKey);
  if (cached) return cached;

  const [progressRes, profileRes] = await Promise.all([
    supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
  ]);

  if (progressRes.error) throw progressRes.error;
  if (profileRes.error) throw profileRes.error;

  if (!progressRes.data) {
    throw new AppError('No onboarding data found', 404);
  }

  const data = progressRes.data;
  const profile = profileRes.data || {};

  if (!data.education?.length && !data.experience?.length) {
    throw new AppError('Add education or experience first', 422);
  }

  const expectedRoleIds = profile.expectedRoleIds || [];
  if (!expectedRoleIds.length) {
    throw new AppError('Target role required', 422);
  }

  const aiContext = buildAIContext(data, profile);

  const userPrompt = JSON.stringify({
    education: data.education || [],
    experience: data.experience || [],
    context: aiContext
  });

  let report;
  const startMs = Date.now();
  const now = new Date().toISOString();

  try {
    const anthropic = getAnthropicClient();
    if (!anthropic) throw new Error('Anthropic client not available');

    const response = await callAnthropicWithRetry(
      () => anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: buildCareerReportPrompt(aiContext.userRegion || 'India'),
        messages: [{ role: 'user', content: userPrompt }],
      }),
      { module: 'careerReport', userId }
    );

    const raw = response.content?.[0]?.text || '{}';
    report = JSON.parse(stripJson(raw));

    if (creditCost) {
      await deductCredits(userId, creditCost, idempotencyKey);
    }

  } catch (err) {
    logAIInteraction({
      module: 'careerReport',
      latencyMs: Date.now() - startMs,
      status: 'error',
      error: err,
      userId,
    });

    throw new AppError('AI generation failed', 502);
  }

  const stepHistory = await mergeStepHistory(userId, 'career_report_generated');

  const { error: upsertError } = await supabase
    .from('onboardingProgress')
    .upsert({
      id: userId,
      step: 'career_report_generated',
      careerReport: report,
      stepHistory,
      updatedAt: now,
    });

  if (upsertError) throw upsertError;

  const [updatedProgress, updatedProfile] = await Promise.all([
    supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
  ]);

  await persistCompletionIfReady(
    userId,
    updatedProgress.data || {},
    updatedProfile.data || {}
  );

  triggerProvisionalChi(userId, data, profile, report, userTier);

  emitOnboardingEvent(userId, 'onboarding_step_completed', {
    step: 'career_report_generated'
  });

  const result = {
    userId,
    step: 'career_report_generated',
    careerReport: report,
  };

  await saveIdempotencyKey(userId, 'careerReport', idempotencyKey, result);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────────────────────────────────────

async function getCareerReportStatus(userId) {
  if (!userId) throw new AppError('userId is required', 400);

  const { data, error } = await supabase
    .from('onboardingProgress')
    .select('careerReport, aiFailures')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) return { status: 'pending' };

  if (data.careerReport) {
    return { status: 'complete' };
  }

  const failure = data.aiFailures?.slice(-1)[0];

  if (failure) {
    return {
      status: 'failed',
      retryable: true,
      retryAfterSeconds: 30
    };
  }

  return { status: 'pending' };
}

module.exports = {
  buildCareerReportPrompt,
  generateCareerReport,
  getCareerReportStatus,
};
