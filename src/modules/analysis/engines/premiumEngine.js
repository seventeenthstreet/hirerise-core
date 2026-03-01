'use strict';

/**
 * premiumEngine.js
 *
 * Premium analysis engine — ONE consolidated Claude call per operation.
 *
 * ARCHITECTURE DECISION:
 *   A single Claude call returns ALL premium outputs in one structured JSON.
 *   This eliminates chained prompts, controls token usage, and makes
 *   cost estimation predictable.
 *
 *   fullAnalysis call returns:
 *     - Resume score + breakdown
 *     - CHI score + all 5 dimensions
 *     - Growth insights
 *     - Salary estimate
 *     - Career roadmap
 *
 *   generateCV call returns:
 *     - Structured CV content
 *
 *   Max tokens are hard-capped to prevent runaway costs.
 *
 * CREDIT FLOW:
 *   Credits are deducted BEFORE this function is called (in analysis.service.js).
 *   If this function throws, the caller refunds credits.
 *   This function is stateless — it only calls Claude and returns the result.
 */

const logger = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const MODEL      = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
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

// ─── System prompts ───────────────────────────────────────────

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
  "peerComparison": "<max 20 words, factual comparison to peers>",
  "growthInsights": ["<max 3 growth observations, under 15 words each>"],
  "salaryEstimate": {
    "currentLPA": <number, conservative Indian market estimate>,
    "nextLevelLPA": <number, next career level estimate>,
    "currency": "INR"
  },
  "roadmap": ["<max 4 steps, concrete, under 12 words each>"]
}

CHI score weighting: skillVelocity 25%, experienceDepth 20%, marketAlignment 25%, salaryTrajectory 15%, careerMomentum 15%.`;

const CV_GENERATION_PROMPT = `You are a professional CV writer specialising in Indian job market standards.
Generate structured CV content from the provided profile data.
Return JSON ONLY. No markdown. No explanation.

Return this exact structure:
{
  "professionalSummary": "<3-4 sentences, first person, achievement-focused>",
  "skills": ["<list of 8-12 specific technical and soft skills>"],
  "experiencePoints": {
    "<company_name>": ["<3-5 bullet points, achievement-driven, quantified where possible>"]
  },
  "educationLines": ["<formatted education entries>"],
  "certifications": ["<if any, else empty array>"],
  "suggestedTitle": "<professional job title for resume header>"
}`;

// ─── Engine functions ─────────────────────────────────────────

/**
 * runFullAnalysis(resumeData)
 * ONE Claude call → score + CHI + growth + salary + roadmap
 */
async function runFullAnalysis(resumeData) {
  const { resumeId, resumeText, fileName, weightedCareerContext } = resumeData;

  logger.debug('[PremiumEngine] runFullAnalysis start', { resumeId });

  const anthropic = getAnthropicClient();

  // Build user prompt — append weighted career context when available.
  // Context presence/absence does NOT change the expected JSON response shape.
  let userPrompt = `Resume Text:\n${resumeText.trim().slice(0, 4000)}`;

  if (Array.isArray(weightedCareerContext) && weightedCareerContext.length > 0) {
    // Format as a concise context block the model can reason from.
    // Roles are already sorted by weight descending (most significant first).
    const contextLines = weightedCareerContext.map(entry => {
      const pct = (entry.weight * 100).toFixed(1);
      const tag = entry.isCurrent ? ' [current]' : '';
      return `  - roleId: ${entry.roleId}${tag} | ${entry.durationMonths}mo | weight: ${pct}%`;
    });
    userPrompt +=
      '\n\nCareer History Context (weighted by duration, most significant first):\n' +
      contextLines.join('\n');
  }

  let raw;
  try {
    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS.fullAnalysis,
      system:     FULL_ANALYSIS_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    raw = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

  } catch (err) {
    logger.error('[PremiumEngine] Claude API call failed', { resumeId, error: err.message });
    throw new AppError(
      'AI analysis failed. Your credits have been refunded.',
      502,
      { resumeId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJson(raw));
  } catch {
    logger.error('[PremiumEngine] JSON parse failed', { raw: raw.slice(0, 200) });
    throw new AppError(
      'AI returned an invalid response. Credits refunded.',
      502,
      { resumeId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  logger.debug('[PremiumEngine] runFullAnalysis complete', {
    resumeId,
    score:    parsed.score,
    chiScore: parsed.chiScore,
  });

  return {
    resumeId,
    fileName,
    engine: 'premium',
    ...parsed,
    scoredAt: new Date().toISOString(),
  };
}

/**
 * runGenerateCV(profileData)
 * ONE Claude call → structured CV content
 */
async function runGenerateCV(profileData) {
  const { userId } = profileData;

  logger.debug('[PremiumEngine] runGenerateCV start', { userId });

  const anthropic  = getAnthropicClient();
  const userPrompt = `Profile Data:\n${JSON.stringify(profileData, null, 2)}`;

  let raw;
  try {
    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS.generateCV,
      system:     CV_GENERATION_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    raw = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

  } catch (err) {
    logger.error('[PremiumEngine] CV generation failed', { userId, error: err.message });
    throw new AppError(
      'CV generation failed. Your credits have been refunded.',
      502,
      { userId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJson(raw));
  } catch {
    throw new AppError(
      'CV generation returned invalid response. Credits refunded.',
      502,
      { userId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  return {
    userId,
    engine:  'premium',
    cvContent: parsed,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runFullAnalysis, runGenerateCV };