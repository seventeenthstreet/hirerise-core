'use strict';

/**
 * src/modules/analysis/premiumEngine.js
 *
 * Production-grade premium AI engine.
 * Supabase-first, cache-aware, observability-ready, and repository-friendly.
 *
 * Responsibilities:
 * - Deterministic analysis hash generation
 * - Tier-based model routing
 * - AI cache reuse
 * - Circuit breaker + concurrency guard
 * - Cost + token telemetry return payload
 * - Strict JSON validation before persistence
 * - Pure engine (NO DB writes here)
 */

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const cbRegistry = require('../../../core/circuitBreaker.registry');
const { withAiConcurrency } = require('../../../core/aiConcurrency');
const { sanitizePromptInput } = require('../../../middleware/aiSanitizer.middleware');
const modelRegistry = require('../../../ai/circuit-breaker/model-registry');
const { buildCacheKey, checkCache, storeCache } = require('../../../core/aiResultCache');
const { withObservability } = require('../../../middleware/ai-observability.middleware');

const MAX_TOKENS = {
  fullAnalysis: 1800,
  generateCV: 2200,
};

function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../../config/anthropic.client');
}

function stripJson(text = '') {
  return String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function buildAnalysisHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function validateAnalysisShape(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid AI response object');
  }

  parsed.score = Math.max(0, Math.min(Number(parsed.score || 0), 100));
  parsed.chiScore = parsed.chiScore == null ? null : Math.max(0, Math.min(Number(parsed.chiScore), 100));
  parsed.topSkills = Array.isArray(parsed.topSkills) ? parsed.topSkills.slice(0, 5) : [];
  parsed.strengths = Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3) : [];
  parsed.improvements = Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 3) : [];
  parsed.growthInsights = Array.isArray(parsed.growthInsights) ? parsed.growthInsights.slice(0, 3) : [];

  return parsed;
}

const FULL_ANALYSIS_PROMPT = `Return ONLY valid JSON for enterprise resume analysis with scoring, breakdown, skills, chiScore, market position, salary trajectory, growth insights, and roadmap.`;
const CV_GENERATION_PROMPT = `Return ONLY valid JSON for ATS-optimized CV generation for the Indian market.`;

async function runFullAnalysis({
  resumeId,
  resumeText,
  fileName,
  weightedCareerContext = [],
  userTier = 'free',
  userId,
}) {
  logger.debug('[PremiumEngine] Full analysis start', { resumeId, userTier });

  const safeResumeText = sanitizePromptInput(resumeText, 'resumeText');

  const analysisHash = buildAnalysisHash({
    resumeText: safeResumeText,
    fileName,
    weightedCareerContext,
  });

  const cacheKey = buildCacheKey('fullAnalysis', { analysisHash, userTier });
  const cached = await checkCache(cacheKey);
  if (cached) {
    return {
      ...cached,
      resumeId,
      analysisHash,
      cacheHit: true,
      cacheSource: 'ai_result_cache',
    };
  }

  const preferredModel = modelRegistry.resolveModelForTier('fullAnalysis', userTier);
  let resolvedModel = preferredModel;
  const startedAt = Date.now();

  const userPrompt = [
    `Resume filename: ${fileName || 'unknown'}`,
    '',
    'Resume content:',
    safeResumeText,
    weightedCareerContext.length
      ? `\nCareer context:\n${JSON.stringify(weightedCareerContext, null, 2)}`
      : '',
  ].join('\n');

  let response;
  try {
    response = await withObservability(
      {
        feature: 'resume_scoring',
        user_id: userId || 'unknown',
        model: preferredModel,
        inputHash: analysisHash,
      },
      async () => withAiConcurrency('fullAnalysis', userId || 'unknown', async () => (
        cbRegistry.execute(
          cbRegistry.FEATURES.RESUME_SCORING,
          async (cbModel) => {
            resolvedModel = cbModel;
            const anthropic = getAnthropicClient();
            return anthropic.messages.create({
              model: cbModel,
              max_tokens: MAX_TOKENS.fullAnalysis,
              system: FULL_ANALYSIS_PROMPT,
              messages: [{ role: 'user', content: userPrompt }],
            });
          }
        )
      ))
    );
  } catch (error) {
    logger.error('[PremiumEngine] Full analysis failed', { resumeId, error: error.message });
    throw new AppError(
      'Premium AI analysis failed.',
      502,
      { resumeId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const latencyMs = Date.now() - startedAt;
  const raw = response.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') || '{}';

  let parsed;
  try {
    parsed = validateAnalysisShape(JSON.parse(stripJson(raw)));
  } catch (error) {
    throw new AppError(
      'AI returned invalid structured analysis.',
      502,
      { resumeId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const aiCostUsd = modelRegistry.estimateCost(resolvedModel, inputTokens, outputTokens);

  const result = {
    resumeId,
    fileName,
    engine: 'premium',
    analysisHash,
    aiModelVersion: resolvedModel,
    weightedCareerContext,
    tokenInputCount: inputTokens,
    tokenOutputCount: outputTokens,
    aiCostUsd,
    latencyMs,
    cacheHit: false,
    cacheSource: null,
    ...parsed,
    scoredAt: new Date().toISOString(),
  };

  await storeCache(cacheKey, result, 'fullAnalysis');
  return result;
}

async function runGenerateCV(profileData, { userTier = 'free', userId } = {}) {
  const resolvedUserId = userId || profileData.userId;
  const sanitizedProfile = {
    ...profileData,
    resumeText: sanitizePromptInput(profileData.resumeText || '', 'resumeText'),
  };

  const generationHash = buildAnalysisHash({
    userId: resolvedUserId,
    skills: sanitizedProfile.skills,
    experience: sanitizedProfile.experience,
    education: sanitizedProfile.education,
  });

  const cacheKey = buildCacheKey('generateCV', { generationHash, userTier });
  const cached = await checkCache(cacheKey);
  if (cached) {
    return {
      ...cached,
      generationHash,
      cacheHit: true,
      cacheSource: 'ai_result_cache',
    };
  }

  const preferredModel = modelRegistry.resolveModelForTier('generateCV', userTier);
  let resolvedModel = preferredModel;
  const startedAt = Date.now();

  let response;
  try {
    response = await withObservability(
      {
        feature: 'cv_generation',
        user_id: resolvedUserId,
        model: preferredModel,
        inputHash: generationHash,
      },
      async () => withAiConcurrency('generateCV', resolvedUserId, async () => (
        cbRegistry.execute(
          cbRegistry.FEATURES.RESUME_SCORING,
          async (cbModel) => {
            resolvedModel = cbModel;
            const anthropic = getAnthropicClient();
            return anthropic.messages.create({
              model: cbModel,
              max_tokens: MAX_TOKENS.generateCV,
              system: CV_GENERATION_PROMPT,
              messages: [{ role: 'user', content: JSON.stringify(sanitizedProfile) }],
            });
          }
        )
      ))
    );
  } catch (error) {
    throw new AppError(
      'Premium CV generation failed.',
      502,
      { user_id: resolvedUserId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const latencyMs = Date.now() - startedAt;
  const raw = response.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') || '{}';
  const cvContent = JSON.parse(stripJson(raw));

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const aiCostUsd = modelRegistry.estimateCost(resolvedModel, inputTokens, outputTokens);

  const result = {
    userId: resolvedUserId,
    engine: 'premium',
    modelVersion: resolvedModel,
    generationHash,
    cvContent,
    inputProfile: sanitizedProfile,
    tokenInputCount: inputTokens,
    tokenOutputCount: outputTokens,
    aiCostUsd,
    latencyMs,
    cacheHit: false,
    generatedAt: new Date().toISOString(),
  };

  await storeCache(cacheKey, result, 'generateCV');
  return result;
}

module.exports = {
  runFullAnalysis,
  runGenerateCV,
  buildAnalysisHash,
};