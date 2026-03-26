'use strict';

/**
 * premiumEngine.js — PHASE 3 UPDATE
 *
 * CHANGES FROM PHASE 2:
 *
 *   1. Tier-based model routing via resolveModelForTier(feature, userTier).
 *      Free users get Haiku, pro get Sonnet, elite get Opus.
 *      Model is passed through circuit breaker — fallback chain still applies.
 *
 *   2. AI result caching via checkCache / storeCache.
 *      Input hash (SHA-256 of resumeText + fileName + weightedCareerContext)
 *      checked before Claude call. Cache hit returns immediately.
 *      Cache stored after successful call. TTL: 4h for fullAnalysis, 2h for CV.
 *
 *   3. withObservability() wrapping all Claude calls.
 *      OTel trace spans, cost tracking, drift observation, and Firestore AI logs
 *      are now wired for every call through this engine.
 *
 *   4. recordAiCost() called after each successful call so aiCostGuard
 *      can enforce per-user daily budget limits.
 *
 * PHASE 2 CHANGES RETAINED:
 *   - Circuit breaker (cbRegistry.execute)
 *   - Global concurrency semaphore (withAiConcurrency)
 *   - Prompt injection sanitization (sanitizePromptInput)
 */

const logger = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

// ── Phase 2 ───────────────────────────────────────────────────────────────────
const cbRegistry             = require('../../../core/circuitBreaker.registry');
const { withAiConcurrency }  = require('../../../core/aiConcurrency');
const { sanitizePromptInput } = require('../../../middleware/aiSanitizer.middleware');

// ── Phase 3 ───────────────────────────────────────────────────────────────────
const modelRegistry           = require('../../../ai/circuit-breaker/model-registry');
const { buildCacheKey, checkCache, storeCache } = require('../../../core/aiResultCache');
const { withObservability }   = require('../../../middleware/ai-observability.middleware');
const { recordAiCost }        = require('../../../middleware/aiCostGuard.middleware');

const MAX_TOKENS = {
  fullAnalysis: 1500,
  generateCV:   2000,
};

function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../../config/anthropic.client');
}

function stripJson(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// ─── System prompts ───────────────────────────────────────────────────────────

const FULL_ANALYSIS_PROMPT = `You are a senior career intelligence analyst specialising in the Indian job market.
Analyse the provided resume and return ONE structured JSON object with ALL fields below.
Be precise. Be conservative. No motivational language. No padding.
Return JSON ONLY. No markdown. No explanation outside JSON.

Return this exact structure:
{
  "score": <integer 0-100>,
  "tier": "excellent|good|average|poor",
  "summary": "<2 sentences, factual, max 30 words>",
  "breakdown": {
    "clarity": <0-100>,
    "relevance": <0-100>,
    "experience": <0-100>,
    "skills": <0-100>,
    "achievements": <0-100>
  },
  "strengths": ["<max 3 items, specific, under 15 words each>"],
  "improvements": ["<max 3 items, specific, actionable, under 15 words each>"],
  "topSkills": ["<max 5 skills detected>"],
  "estimatedExperienceYears": <integer>,
  "chiScore": <integer 0-100, weighted career health>,
  "dimensions": {
    "skillVelocity":    { "score": <0-100>, "insight": "<max 12 words>", "flag": <boolean> },
    "experienceDepth":  { "score": <0-100>, "insight": "<max 12 words>", "flag": <boolean> },
    "marketAlignment":  { "score": <0-100>, "insight": "<max 12 words>", "flag": <boolean> },
    "salaryTrajectory": { "score": <0-100>, "insight": "<max 12 words>", "flag": <boolean> },
    "careerMomentum":   { "score": <0-100>, "insight": "<max 12 words>", "flag": <boolean> }
  },
  "marketPosition": "top10|top25|top50|bottom50",
  "peerComparison": "<max 20 words>",
  "projectedLevelUpMonths": <integer>,
  "currentEstimatedSalaryLPA": <number>,
  "nextLevelEstimatedSalaryLPA": <number>,
  "growthInsights": ["<max 3 insights, specific, under 20 words each>"],
  "careerRoadmap": {
    "immediate": "<action for next 30 days, max 20 words>",
    "shortTerm": "<action for next 3 months, max 20 words>",
    "longTerm":  "<action for next 12 months, max 20 words>"
  }
}`;

const CV_GENERATION_PROMPT = `You are an expert CV writer specialising in the Indian job market.
Generate a professional, ATS-optimised CV from the provided profile data.
Return JSON ONLY. No markdown. No commentary outside JSON.

Return this structure:
{
  "headline": "<professional headline, max 15 words>",
  "summary": "<professional summary, 3-4 sentences, max 80 words>",
  "experience": [
    {
      "title": "<job title>",
      "company": "<company name>",
      "duration": "<e.g. Jan 2021 - Present>",
      "bullets": ["<achievement bullet, max 20 words each, max 4 bullets>"]
    }
  ],
  "skills": {
    "technical": ["<skill>"],
    "soft": ["<skill>"]
  },
  "education": [
    {
      "degree": "<degree>",
      "institution": "<institution>",
      "year": "<graduation year>"
    }
  ],
  "certifications": ["<certification name>"]
}`;

// ─── runFullAnalysis ──────────────────────────────────────────────────────────

/**
 * PHASE 3 CHANGES:
 *   - userTier parameter added (forwarded from route → service → engine)
 *   - resolveModelForTier selects Haiku/Sonnet/Opus based on tier
 *   - Result checked in cache before calling Claude
 *   - withObservability wraps the Claude call (traces, logs, cost tracking)
 *   - recordAiCost records actual spend for aiCostGuard enforcement
 */
async function runFullAnalysis({ resumeId, resumeText, fileName, weightedCareerContext, userTier, userId }) {
  logger.debug('[PremiumEngine] runFullAnalysis start', { resumeId, userTier });

  // ── Phase 2: sanitize ─────────────────────────────────────────────────────
  const safeResumeText = sanitizePromptInput(resumeText, 'resumeText');

  // ── Phase 3: result cache check ───────────────────────────────────────────
  const cacheKey = buildCacheKey('fullAnalysis', {
    resumeText:           safeResumeText,
    fileName:             fileName || '',
    weightedCareerContext: weightedCareerContext || [],
  });

  const cached = await checkCache(cacheKey);
  if (cached) {
    logger.info('[PremiumEngine] Cache hit — skipping Claude call', { resumeId, cacheKey });
    return { ...cached, resumeId, _cached: true };
  }

  // ── Phase 3: tier-based model selection ──────────────────────────────────
  const model = modelRegistry.resolveModelForTier('fullAnalysis', userTier);

  let userPrompt = `Resume filename: ${fileName || 'unknown'}\n\nResume content:\n${safeResumeText}`;
  if (weightedCareerContext?.length) {
    const contextLines = weightedCareerContext.map(entry => {
      const pct = (entry.weight * 100).toFixed(1);
      const tag = entry.isCurrent ? ' [current]' : '';
      return `  - roleId: ${entry.roleId}${tag} | ${entry.durationMonths}mo | weight: ${pct}%`;
    });
    userPrompt += '\n\nCareer History Context (weighted by duration, most significant first):\n' + contextLines.join('\n');
  }

  let raw;
  let resolvedModel = model;

  try {
    // ── Phase 3: withObservability wraps the full call ─────────────────────
    const response = await withObservability(
      {
        feature:  'resume_scoring',
        user_id:   userId || 'unknown',
        model,
        inputHash: cacheKey,
      },
      async (modelToUse) => {
        resolvedModel = modelToUse;
        // ── Phase 2: concurrency semaphore + circuit breaker ────────────────
        return withAiConcurrency('fullAnalysis', userId || 'unknown', async () => {
          return cbRegistry.execute(
            cbRegistry.FEATURES.RESUME_SCORING,
            async (cbModel) => {
              resolvedModel = cbModel;
              const anthropic = getAnthropicClient();
              return anthropic.messages.create({
                model:      cbModel,
                max_tokens: MAX_TOKENS.fullAnalysis,
                system:     FULL_ANALYSIS_PROMPT,
                messages:   [{ role: 'user', content: userPrompt }],
              });
            }
          );
        });
      }
    );

    raw = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // ── Phase 3: record actual cost for per-user budget enforcement ────────
    const inputTokens  = response.usage?.input_tokens  ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const costUSD = modelRegistry.estimateCost(resolvedModel, inputTokens, outputTokens);
    recordAiCost(userId || 'unknown', userTier || 'free', costUSD).catch(() => {});

  } catch (err) {
    logger.error('[PremiumEngine] Claude API call failed', { resumeId, error: err.message });
    if (err.statusCode === 503 || err.status === 503) throw err;
    throw new AppError(
      'AI analysis failed. Your credits have been refunded.',
      502, { resumeId }, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJson(raw));
  } catch {
    logger.error('[PremiumEngine] JSON parse failed', { raw: raw.slice(0, 200) });
    throw new AppError(
      'AI returned an invalid response. Credits refunded.',
      502, { resumeId }, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  logger.debug('[PremiumEngine] runFullAnalysis complete', {
    resumeId, score: parsed.score, chiScore: parsed.chiScore, model: resolvedModel,
  });

  const result = {
    resumeId,
    fileName,
    engine:         'premium',
    aiModelVersion: resolvedModel,
    ...parsed,
    scoredAt: new Date().toISOString(),
  };

  // ── Phase 3: store in cache for future identical requests ──────────────
  await storeCache(cacheKey, result, 'fullAnalysis');

  return result;
}

// ─── runGenerateCV ────────────────────────────────────────────────────────────

async function runGenerateCV(profileData, { userTier, userId } = {}) {
  const resolvedUserId = userId || profileData.userId;
  logger.debug('[PremiumEngine] runGenerateCV start', { user_id: resolvedUserId, userTier });

  const safeProfileData = { ...profileData };
  if (safeProfileData.resumeText) {
    safeProfileData.resumeText = sanitizePromptInput(safeProfileData.resumeText, 'resumeText');
  }

  // ── Phase 3: result cache ─────────────────────────────────────────────────
  const cacheKey = buildCacheKey('generateCV', {
    user_id: resolvedUserId,
    skills:  safeProfileData.skills,
    experience: safeProfileData.experience,
    education:  safeProfileData.education,
  });

  const cached = await checkCache(cacheKey);
  if (cached) {
    logger.info('[PremiumEngine] CV Cache hit', { user_id: resolvedUserId });
    return { ...cached, _cached: true };
  }

  // ── Phase 3: tier routing ─────────────────────────────────────────────────
  const model = modelRegistry.resolveModelForTier('generateCV', userTier);

  const userPrompt = `Profile Data:\n${JSON.stringify(safeProfileData, null, 2)}`;
  let raw;
  let resolvedModel = model;

  try {
    const response = await withObservability(
      { feature: 'resume_scoring', user_id: resolvedUserId, model, inputHash: cacheKey },
      async () => {
        return withAiConcurrency('generateCV', resolvedUserId, async () => {
          return cbRegistry.execute(
            cbRegistry.FEATURES.RESUME_SCORING,
            async (cbModel) => {
              resolvedModel = cbModel;
              const anthropic = getAnthropicClient();
              return anthropic.messages.create({
                model:      cbModel,
                max_tokens: MAX_TOKENS.generateCV,
                system:     CV_GENERATION_PROMPT,
                messages:   [{ role: 'user', content: userPrompt }],
              });
            }
          );
        });
      }
    );

    raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    const inputTokens  = response.usage?.input_tokens  ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const costUSD = modelRegistry.estimateCost(resolvedModel, inputTokens, outputTokens);
    recordAiCost(resolvedUserId, userTier || 'free', costUSD).catch(() => {});

  } catch (err) {
    logger.error('[PremiumEngine] CV generation failed', { user_id: resolvedUserId, error: err.message });
    if (err.statusCode === 503 || err.status === 503) throw err;
    throw new AppError(
      'CV generation failed. Your credits have been refunded.',
      502, { user_id: resolvedUserId }, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJson(raw));
  } catch {
    throw new AppError(
      'CV generation returned invalid response. Credits refunded.',
      502, { user_id: resolvedUserId }, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const result = {
    user_id:         resolvedUserId,
    engine:         'premium',
    aiModelVersion: resolvedModel,
    cvContent:      parsed,
    generatedAt:    new Date().toISOString(),
  };

  await storeCache(cacheKey, result, 'generateCV');
  return result;
}

module.exports = { runFullAnalysis, runGenerateCV };








