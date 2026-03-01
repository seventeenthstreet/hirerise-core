'use strict';

/**
 * coverLetter.engine.js
 *
 * Single Claude call → tailored cover letter.
 *
 * ARCHITECTURE:
 *   Mirrors premiumEngine.js pattern exactly.
 *   Stateless — receives data, returns result, throws on failure.
 *   Credit deduction/refund happens upstream in coverLetter.service.js.
 *   Never called directly from routes.
 *
 * TOKEN BUDGET:
 *   Cover letters are naturally bounded in length.
 *   800 tokens generates ~500-600 word letters — appropriate for the format.
 *   Hard cap prevents runaway costs if Claude over-generates.
 */

const logger = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const MODEL      = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = 800;

function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../../config/anthropic.client');
}

// ─── System prompt ────────────────────────────────────────────────────────────

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

// ─── Tone map ─────────────────────────────────────────────────────────────────

const VALID_TONES = ['professional', 'confident', 'conversational', 'formal'];

// ─── Main engine function ─────────────────────────────────────────────────────

/**
 * generateCoverLetter({ userId, companyName, jobTitle, jobDescription, tone })
 *
 * @returns {{ content: string, inputTokens: number, outputTokens: number, model: string }}
 */
async function generateCoverLetter({ userId, companyName, jobTitle, jobDescription, tone = 'professional' }) {
  const resolvedTone = VALID_TONES.includes(tone) ? tone : 'professional';

  const userPrompt = [
    `Company: ${companyName}`,
    `Role: ${jobTitle}`,
    `Tone: ${resolvedTone}`,
    ``,
    `Job Description:`,
    jobDescription.trim().slice(0, 3500), // matches Zod max — input already validated upstream
  ].join('\n');

  logger.debug('[CoverLetterEngine] Calling Claude', { userId, companyName, jobTitle, tone: resolvedTone });

  const anthropic = getAnthropicClient();

  let response;
  try {
    response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     COVER_LETTER_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    logger.error('[CoverLetterEngine] Claude API call failed', { userId, error: err.message });
    throw new AppError(
      'Cover letter generation failed. Your credits have been refunded.',
      502,
      {},
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const content = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (!content || content.length < 100) {
    logger.error('[CoverLetterEngine] Claude returned empty/short content', { userId, length: content.length });
    throw new AppError(
      'Cover letter generation returned an empty response. Credits refunded.',
      502,
      {},
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  logger.debug('[CoverLetterEngine] Generation complete', {
    userId,
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    contentLength: content.length,
  });

  return {
    content,
    model:        response.model,
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

module.exports = { generateCoverLetter, VALID_TONES };