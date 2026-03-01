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
 */

const logger = require('../../utils/logger');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const MODEL       = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const TEMPERATURE = 0.3;
const MAX_TOKENS  = {
  jobMatchAnalysis: 1200,
  jobSpecificCV:    1800,  // larger — includes tailored CV content
};
const MAX_RETRIES     = 1;
const RETRY_DELAY_MS  = 1500;
const TEXT_LIMIT      = 3500; // chars per input field

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

async function callClaude(anthropic, params) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      logger.warn('[JobMatchPremiumEngine] Retrying Claude call', { attempt });
      await sleep(RETRY_DELAY_MS);
    }
    try {
      const res = await anthropic.messages.create(params);
      return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    } catch (err) {
      lastError = err;
      logger.warn('[JobMatchPremiumEngine] Attempt failed', { attempt, error: err.message });
    }
  }
  throw lastError;
}

// ─── Prompts ──────────────────────────────────────────────────

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

// ─── Engine functions ─────────────────────────────────────────

/**
 * runJobMatchAnalysis({ resumeText, jobDescription })
 * operationType: 'jobMatchAnalysis'
 * Returns: match score + gaps + suggestions (no CV)
 */
async function runJobMatchAnalysis({ resumeText, jobDescription }) {
  logger.info('[JobMatchPremiumEngine] jobMatchAnalysis start');

  const anthropic  = getAnthropicClient();
  const userPrompt =
    `Resume:\n${resumeText.trim().slice(0, TEXT_LIMIT)}\n\nJob Description:\n${jobDescription.trim().slice(0, TEXT_LIMIT)}`;

  let raw;
  try {
    raw = await callClaude(anthropic, {
      model:       MODEL,
      max_tokens:  MAX_TOKENS.jobMatchAnalysis,
      temperature: TEMPERATURE,
      system:      MATCH_ANALYSIS_PROMPT,
      messages:    [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    logger.error('[JobMatchPremiumEngine] Claude unavailable after retry', { error: err.message });
    throw new AppError(
      'JD analysis failed after retry. Your credits have been refunded.',
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

  logger.info('[JobMatchPremiumEngine] jobMatchAnalysis complete', { matchScore: parsed.matchScore });

  return {
    engine: 'premium',
    ...parsed,
    tailoredCV:  null,  // not requested in this operation
    analysedAt:  new Date().toISOString(),
  };
}

/**
 * runJobSpecificCV({ resumeText, jobDescription, personalDetails })
 * operationType: 'jobSpecificCV'
 * Returns: match analysis + fully tailored CV
 */
async function runJobSpecificCV({ resumeText, jobDescription, personalDetails = {} }) {
  logger.info('[JobMatchPremiumEngine] jobSpecificCV start');

  const anthropic  = getAnthropicClient();
  const userPrompt =
    `Resume:\n${resumeText.trim().slice(0, TEXT_LIMIT)}\n\nJob Description:\n${jobDescription.trim().slice(0, TEXT_LIMIT)}\n\nProfile Details:\n${JSON.stringify(personalDetails)}`;

  let raw;
  try {
    raw = await callClaude(anthropic, {
      model:       MODEL,
      max_tokens:  MAX_TOKENS.jobSpecificCV,
      temperature: TEMPERATURE,
      system:      JOB_SPECIFIC_CV_PROMPT,
      messages:    [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    logger.error('[JobMatchPremiumEngine] CV generation failed after retry', { error: err.message });
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

  logger.info('[JobMatchPremiumEngine] jobSpecificCV complete', { matchScore: parsed.matchScore });

  return {
    engine:     'premium',
    ...parsed,
    analysedAt: new Date().toISOString(),
  };
}

module.exports = { runJobMatchAnalysis, runJobSpecificCV };