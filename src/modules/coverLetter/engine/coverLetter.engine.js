'use strict';

/**
 * coverLetter.engine.js
 *
 * Stateless Claude engine for tailored cover letter generation.
 *
 * Responsibilities:
 * - Build safe AI prompt
 * - Execute single Anthropic API request
 * - Validate response quality
 * - Return normalized token usage metadata
 *
 * No DB logic.
 * No credit logic.
 * No HTTP concerns.
 */

const logger = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = 800;
const MIN_CONTENT_LENGTH = 100;

const VALID_TONES = Object.freeze([
  'professional',
  'confident',
  'conversational',
  'formal',
]);

let anthropicClient;

/**
 * Singleton Anthropic client resolver.
 *
 * @returns {any|null}
 */
function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  if (anthropicClient) {
    return anthropicClient;
  }

  anthropicClient = require('../../../config/anthropic.client');
  return anthropicClient;
}

const COVER_LETTER_SYSTEM_PROMPT = `You are a professional cover letter writer specialising in the Indian job market.

Write a tailored, compelling cover letter based on the provided job description, company, and role.

RULES:
- 3 to 4 paragraphs only
- Opening: why this company and role specifically (not generic)
- Middle: 2-3 concrete achievements or skills directly relevant to the JD
- Closing: clear call to action
- No filler phrases ("I am writing to apply...", "I am a hard worker...")
- No bullet points — flowing prose only
- Tone: adapt to the requested tone. Default is "professional"
- Length: 280–380 words maximum
- Return ONLY the cover letter text — no subject line, no date, no address block`;

/**
 * Normalize and validate tone.
 *
 * @param {string} tone
 * @returns {string}
 */
function resolveTone(tone) {
  return VALID_TONES.includes(tone) ? tone : 'professional';
}

/**
 * Build user prompt safely.
 *
 * @param {object} params
 * @returns {string}
 */
function buildUserPrompt({
  companyName,
  jobTitle,
  jobDescription,
  tone,
}) {
  return [
    `Company: ${String(companyName || '').trim()}`,
    `Role: ${String(jobTitle || '').trim()}`,
    `Tone: ${tone}`,
    '',
    'Job Description:',
    String(jobDescription || '').trim().slice(0, 3500),
  ].join('\n');
}

/**
 * Safely extract Claude text blocks.
 *
 * @param {any} response
 * @returns {string}
 */
function extractTextContent(response) {
  const blocks = Array.isArray(response?.content)
    ? response.content
    : [];

  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Normalize token usage safely.
 *
 * @param {any} response
 * @returns {{inputTokens:number, outputTokens:number}}
 */
function extractUsage(response) {
  return {
    inputTokens: response?.usage?.input_tokens ?? 0,
    outputTokens: response?.usage?.output_tokens ?? 0,
  };
}

/**
 * generateCoverLetter({
 *   userId,
 *   companyName,
 *   jobTitle,
 *   jobDescription,
 *   tone
 * })
 *
 * @returns {Promise<{
 *   content: string,
 *   inputTokens: number,
 *   outputTokens: number,
 *   model: string
 * }>}
 */
async function generateCoverLetter({
  userId,
  companyName,
  jobTitle,
  jobDescription,
  tone = 'professional',
}) {
  const resolvedTone = resolveTone(tone);
  const anthropic = getAnthropicClient();

  if (!anthropic) {
    throw new AppError(
      'Anthropic client unavailable in current environment.',
      500,
      {},
      ErrorCodes.INTERNAL_SERVER_ERROR
    );
  }

  const userPrompt = buildUserPrompt({
    companyName,
    jobTitle,
    jobDescription,
    tone: resolvedTone,
  });

  logger.debug('[CoverLetterEngine] Claude request started', {
    userId,
    companyName,
    jobTitle,
    tone: resolvedTone,
    model: MODEL,
  });

  let response;

  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: COVER_LETTER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });
  } catch (error) {
    logger.error('[CoverLetterEngine] Claude API call failed', {
      userId,
      error: error.message,
      model: MODEL,
    });

    throw new AppError(
      'Cover letter generation failed. Your credits have been refunded.',
      502,
      {},
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const content = extractTextContent(response);
  const usage = extractUsage(response);

  if (!content || content.length < MIN_CONTENT_LENGTH) {
    logger.error('[CoverLetterEngine] Claude returned invalid content', {
      userId,
      contentLength: content?.length ?? 0,
      model: response?.model ?? MODEL,
    });

    throw new AppError(
      'Cover letter generation returned an empty response. Credits refunded.',
      502,
      {},
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  logger.debug('[CoverLetterEngine] Claude generation complete', {
    userId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    contentLength: content.length,
    model: response?.model ?? MODEL,
  });

  return {
    content,
    model: response?.model ?? MODEL,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

module.exports = {
  generateCoverLetter,
  VALID_TONES,
};