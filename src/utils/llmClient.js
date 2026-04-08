'use strict';

/**
 * llmClient.js — Production LLM Wrapper
 *
 * Responsibilities:
 * - strict caller contract
 * - provider-router bridge
 * - resilient JSON extraction
 * - structured logging
 * - safe prompt serialization
 */

const { generateAIResponse } = require('../services/aiRouter');
const logger = require('./logger');

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2048;
const PROVIDER_DOWN_MESSAGE = 'AI service temporarily unavailable.';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Extract first JSON object/array block from mixed prose.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractJsonBlock(text) {
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) return objectMatch[0];

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];

  return null;
}

/**
 * Strip markdown fences and parse JSON safely.
 *
 * @param {string} raw
 * @returns {object|Array}
 */
function stripAndParseJSON(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('[llmClient] LLM returned an empty or non-string response');
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```$/im, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const extracted = extractJsonBlock(cleaned);

    if (!extracted) {
      throw new Error(
        `[llmClient] No valid JSON block found.\nPreview:\n${raw.slice(0, 400)}`
      );
    }

    try {
      return JSON.parse(extracted);
    } catch {
      throw new Error(
        `[llmClient] Extracted JSON block failed to parse.\nPreview:\n${raw.slice(0, 400)}`
      );
    }
  }
}

/**
 * Build provider-safe prompt.
 *
 * @param {string} systemPrompt
 * @param {object} input
 * @returns {string}
 */
function buildPrompt(systemPrompt, input) {
  return [
    systemPrompt.trim(),
    '',
    '---',
    'INPUT DATA (JSON):',
    JSON.stringify(input, null, 2),
    '',
    'Return ONLY valid JSON.',
    'No markdown fences.',
    'No explanation.',
    'No prose.',
  ].join('\n');
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Generate structured JSON output from LLM.
 *
 * @param {{
 *   systemPrompt: string,
 *   input: object,
 *   temperature?: number,
 *   maxTokens?: number
 * }} params
 * @returns {Promise<object|Array>}
 */
async function generate({
  systemPrompt,
  input,
  temperature = DEFAULT_TEMPERATURE,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
    throw new Error('[llmClient] systemPrompt must be a non-empty string');
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('[llmClient] input must be a non-null object');
  }

  const combinedPrompt = buildPrompt(systemPrompt, input);

  logger.debug('[llmClient] Dispatching to AI router', {
    prompt_chars: combinedPrompt.length,
    temperature,
    max_tokens: maxTokens,
    input_keys: Object.keys(input),
  });

  const rawText = await generateAIResponse(combinedPrompt, {
    temperature,
    maxTokens,
  });

  if (
    typeof rawText !== 'string' ||
    rawText.trim().length === 0 ||
    rawText === PROVIDER_DOWN_MESSAGE
  ) {
    throw new Error(
      '[llmClient] All AI providers are currently unavailable. Please retry shortly.'
    );
  }

  const parsed = stripAndParseJSON(rawText);

  logger.debug('[llmClient] LLM response parsed successfully', {
    response_type: Array.isArray(parsed) ? 'array' : 'object',
    top_level_keys: Array.isArray(parsed)
      ? []
      : Object.keys(parsed),
  });

  return parsed;
}

module.exports = {
  generate,
  stripAndParseJSON,
};