'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const cbRegistry = require('../../core/circuitBreaker.registry');
const { withAiConcurrency } = require('../../core/aiConcurrency');
const { sanitizePromptInput } = require('../../middleware/aiSanitizer.middleware');
const {
  buildCacheKey,
  checkCache,
  storeCache,
} = require('../../core/aiResultCache');
const modelRegistry = require('../../ai/circuit-breaker/model-registry');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const TEMPERATURE = 0.3;
const TEXT_LIMIT = 3500;

const MAX_TOKENS = {
  jobMatchAnalysis: 1200,
  jobSpecificCV: 1800,
};

function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
}

function buildJobMatchHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {}

  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch (_) {}

  return null;
}

function normalizeResult(parsed) {
  return {
    matchScore: Math.max(0, Math.min(parsed.matchScore || 0, 100)),
    alignmentSummary: parsed.alignmentSummary || null,
    presentKeywords: (parsed.presentSkills || []).slice(0, 6),
    missingKeywords: (parsed.missingSkills || []).slice(0, 6),
    improvementSuggestions: (parsed.improvementSuggestions || []).slice(0, 4),
    hiringRisk: parsed.hiringRisk || null,
    tailoredCV: parsed.tailoredCV || null,
  };
}

async function executeJobMatch(feature, prompt, userId, cacheKey) {
  const cached = await checkCache(cacheKey);
  if (cached) {
    return {
      ...cached,
      cacheHit: true,
      cacheSource: 'ai_result_cache',
    };
  }

  let resolvedModel = MODEL;
  const startedAt = Date.now();

  const response = await withAiConcurrency(feature, userId, async () =>
    cbRegistry.execute(
      cbRegistry.FEATURES.RESUME_SCORING,
      async (model) => {
        resolvedModel = model;
        const anthropic = getAnthropicClient();
        return anthropic.messages.create({
          model,
          max_tokens: MAX_TOKENS[feature],
          temperature: TEMPERATURE,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        });
      }
    )
  );

  const latencyMs = Date.now() - startedAt;
  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = parseJsonSafe(raw);
  if (!parsed) {
    throw new AppError(
      'AI returned invalid JSON.',
      502,
      {},
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const aiCostUsd = modelRegistry.estimateCost(
    resolvedModel,
    inputTokens,
    outputTokens
  );

  const result = {
    engine: 'premium',
    aiModelVersion: resolvedModel,
    tokenInputCount: inputTokens,
    tokenOutputCount: outputTokens,
    latencyMs,
    aiCostUsd,
    cacheHit: false,
    cacheSource: null,
    ...normalizeResult(parsed),
    analysedAt: new Date().toISOString(),
  };

  await storeCache(cacheKey, result, feature);
  return result;
}

async function runJobMatchAnalysis({
  resumeText,
  jobDescription,
  userId = 'unknown',
}) {
  const safeResume = sanitizePromptInput(resumeText, 'resumeText');
  const safeJD = sanitizePromptInput(jobDescription, 'jobDescription');

  const analysisHash = buildJobMatchHash({
    safeResume,
    safeJD,
    feature: 'jobMatchAnalysis',
  });

  const cacheKey = buildCacheKey('jobMatchAnalysis', { analysisHash });

  const result = await executeJobMatch(
    'jobMatchAnalysis',
    {
      system: MATCH_ANALYSIS_PROMPT,
      user: `Resume:\n${safeResume.slice(0, TEXT_LIMIT)}\n\nJob Description:\n${safeJD.slice(0, TEXT_LIMIT)}`,
    },
    userId,
    cacheKey
  );

  return { ...result, analysisHash };
}