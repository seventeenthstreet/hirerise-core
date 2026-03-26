'use strict';

/**
 * jobMatchPremiumEngine.js
 *
 * Premium JD analysis — ONE consolidated Claude call per operation.
 *
 * ARCHITECTURE:
 *   jobMatchAnalysis: ONE call returns match score + gaps + suggestions.
 *   jobSpecificCV:    ONE call returns all of the above + tailored CV content.
 *   Never chain two calls. Never call Claude twice per request.
 *
 * COST CONTROLS:
 *   temperature: 0.3 — structured output, some strategic variation
 *   max_tokens capped per operation (hard constants)
 *   Input text sliced at 3500 chars each (resume + JD)
 *   retry: max 1 attempt, 1500ms delay
 *   Credits deducted by caller before this function runs.
 *   If this throws → caller refunds.
 *
 * PHASE 2 CHANGES:
 *   1. callClaude() replaced with cbRegistry.execute() — circuit breaker protection.
 *      Direct anthropic.messages.create() is gone from both engine functions.
 *
 *   2. Both engine functions wrapped with withAiConcurrency()
 *      — global Redis semaphore prevents concurrent call spikes.
 *
 *   3. resumeText and jobDescription passed through sanitizePromptInput()
 *      before being placed in the user prompt.
 *
 *   4. aiModelVersion included in both return objects.
 */

const logger = require('../../utils/logger');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// ── PHASE 2: circuit breaker ───────────────────────────────────────────────────
const cbRegistry = require('../../core/circuitBreaker.registry');

// ── PHASE 2: global concurrency semaphore ─────────────────────────────────────
const { withAiConcurrency } = require('../../core/aiConcurrency');

// ── PHASE 2: prompt injection sanitizer ───────────────────────────────────────
const { sanitizePromptInput } = require('../../middleware/aiSanitizer.middleware');

const MODEL       = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const TEMPERATURE = 0.3;
const MAX_TOKENS  = {
  jobMatchAnalysis: 1200,
  jobSpecificCV:    1800,
};
const TEXT_LIMIT = 3500;

function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseJsonSafe(raw) {
  try { return JSON.parse(raw); } catch { /* */ }
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch { /* */ }
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* */ } }
  return null;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const MATCH_ANALYSIS_PROMPT = `You are a senior career strategist and hiring consultant specialising in the Indian job market.
You will receive a resume and a job description.
Analyse the strategic fit and return ONE structured JSON object.
Be precise, factual, and strategic. No generic advice. No filler.
Return JSON ONLY. No markdown. No text outside the JSON object.

Required structure:
{
  "matchScore": <integer 0-100, true strategic fit score>,
  "alignmentSummary": "<3-4 sentences: where the candidate fits well and where they fall short. Factual, specific.>",
  "presentSkills": ["<max 6 skills/experiences that match the JD>"],
  "missingSkills": ["<max 6 specific skills/experiences the JD requires but resume lacks>"],
  "improvementSuggestions": [
    "<max 4 items — specific, actionable changes to resume OR profile to improve match. Under 20 words each.>"
  ],
  "hiringRisk": "<1 sentence — the single biggest reason this candidate might be rejected>"
}`;

const JOB_SPECIFIC_CV_PROMPT = `You are a senior career strategist and professional CV writer for the Indian job market.
You will receive a resume, a job description, and profile details.
Analyse the fit AND generate a fully tailored CV optimised for this specific role.
Return ONE structured JSON object. No markdown. No text outside JSON.

Required structure:
{
  "matchScore": <integer 0-100>,
  "alignmentSummary": "<3-4 sentences, factual, specific>",
  "presentSkills": ["<max 6 matching skills>"],
  "missingSkills": ["<max 6 gaps>"],
  "improvementSuggestions": ["<max 4 actionable items, under 20 words each>"],
  "hiringRisk": "<1 sentence — biggest rejection risk>",
  "tailoredCV": {
    "suggestedTitle": "<role title optimised for this JD>",
    "professionalSummary": "<4-5 sentences, first person, written specifically for this JD. Highlight most relevant experience first.>",
    "skills": ["<10-14 skills, prioritised by JD relevance>"],
    "experiencePoints": {
      "<company_name>": ["<3-5 bullet points rewritten to emphasise JD-relevant achievements. Quantified where possible.>"]
    },
    "educationLines": ["<formatted education entries>"],
    "keywordsAdded": ["<list of JD keywords strategically embedded in the CV>"]
  }
}`;

// ─── runJobMatchAnalysis ──────────────────────────────────────────────────────

/**
 * PHASE 2 CHANGES:
 *   - resumeText and jobDescription sanitized before prompt construction
 *   - callClaude() replaced with withAiConcurrency + cbRegistry.execute
 */
async function runJobMatchAnalysis({ resumeText, jobDescription, userId = 'unknown' }) {
  logger.info('[JobMatchPremiumEngine] jobMatchAnalysis start');

  // ── PHASE 2: sanitize user-controlled inputs ───────────────────────────────
  const safeResumeText    = sanitizePromptInput(resumeText,    'resumeText');
  const safeJobDescription = sanitizePromptInput(jobDescription, 'jobDescription');

  const userPrompt =
    `Resume:\n${safeResumeText.trim().slice(0, TEXT_LIMIT)}\n\nJob Description:\n${safeJobDescription.trim().slice(0, TEXT_LIMIT)}`;

  let raw;
  let resolvedModel = MODEL;

  try {
    // ── PHASE 2: concurrency semaphore + circuit breaker ──────────────────
    const response = await withAiConcurrency('jobMatchAnalysis', userId, async () => {
      return cbRegistry.execute(
        cbRegistry.FEATURES.RESUME_SCORING, // job match shares model chain with resume scoring
        async (model) => {
          resolvedModel = model;
          const anthropic = getAnthropicClient();
          return anthropic.messages.create({
            model,
            max_tokens:  MAX_TOKENS.jobMatchAnalysis,
            temperature: TEMPERATURE,
            system:      MATCH_ANALYSIS_PROMPT,
            messages:    [{ role: 'user', content: userPrompt }],
          });
        }
      );
    });

    raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  } catch (err) {
    logger.error('[JobMatchPremiumEngine] Claude unavailable', { error: err.message });
    if (err.statusCode === 503 || err.status === 503) throw err;
    throw new AppError(
      'JD analysis failed. Your credits have been refunded.',
      502, {}, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const parsed = parseJsonSafe(raw);
  if (!parsed) {
    logger.error('[JobMatchPremiumEngine] JSON parse failed', { raw: raw.slice(0, 300) });
    throw new AppError(
      'AI returned an invalid response. Credits refunded.',
      502, {}, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  logger.info('[JobMatchPremiumEngine] jobMatchAnalysis complete', {
    matchScore: parsed.matchScore, model: resolvedModel,
  });

  return {
    engine:         'premium',
    aiModelVersion: resolvedModel,
    ...parsed,
    tailoredCV:  null,
    analysedAt:  new Date().toISOString(),
  };
}

// ─── runJobSpecificCV ─────────────────────────────────────────────────────────

/**
 * PHASE 2 CHANGES:
 *   - resumeText and jobDescription sanitized before prompt construction
 *   - callClaude() replaced with withAiConcurrency + cbRegistry.execute
 */
async function runJobSpecificCV({ resumeText, jobDescription, personalDetails = {}, userId = 'unknown' }) {
  logger.info('[JobMatchPremiumEngine] jobSpecificCV start');

  // ── PHASE 2: sanitize user-controlled inputs ───────────────────────────────
  const safeResumeText     = sanitizePromptInput(resumeText,    'resumeText');
  const safeJobDescription = sanitizePromptInput(jobDescription, 'jobDescription');

  const userPrompt =
    `Resume:\n${safeResumeText.trim().slice(0, TEXT_LIMIT)}\n\nJob Description:\n${safeJobDescription.trim().slice(0, TEXT_LIMIT)}\n\nProfile Details:\n${JSON.stringify(personalDetails)}`;

  let raw;
  let resolvedModel = MODEL;

  try {
    // ── PHASE 2: concurrency semaphore + circuit breaker ──────────────────
    const response = await withAiConcurrency('jobSpecificCV', userId, async () => {
      return cbRegistry.execute(
        cbRegistry.FEATURES.RESUME_SCORING,
        async (model) => {
          resolvedModel = model;
          const anthropic = getAnthropicClient();
          return anthropic.messages.create({
            model,
            max_tokens:  MAX_TOKENS.jobSpecificCV,
            temperature: TEMPERATURE,
            system:      JOB_SPECIFIC_CV_PROMPT,
            messages:    [{ role: 'user', content: userPrompt }],
          });
        }
      );
    });

    raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  } catch (err) {
    logger.error('[JobMatchPremiumEngine] CV generation failed', { error: err.message });
    if (err.statusCode === 503 || err.status === 503) throw err;
    throw new AppError(
      'Tailored CV generation failed. Credits refunded.',
      502, {}, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const parsed = parseJsonSafe(raw);
  if (!parsed) {
    throw new AppError(
      'Tailored CV returned invalid response. Credits refunded.',
      502, {}, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  logger.info('[JobMatchPremiumEngine] jobSpecificCV complete', {
    matchScore: parsed.matchScore, model: resolvedModel,
  });

  return {
    engine:         'premium',
    aiModelVersion: resolvedModel,
    ...parsed,
    analysedAt: new Date().toISOString(),
  };
}

module.exports = { runJobMatchAnalysis, runJobSpecificCV };








