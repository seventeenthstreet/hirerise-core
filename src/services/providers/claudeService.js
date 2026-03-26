'use strict';

/**
 * claudeService.js — Anthropic Claude 3 Haiku Provider (LAST RESORT)
 *
 * Claude is intentionally last in the fallback chain.
 * API key retrieved from Secret Manager — never from environment variables.
 * Returns a standardized { provider, text } response object.
 */

const { getSecret } = require('../../modules/secrets');
const logger        = require('../../utils/logger');

const PROVIDER_NAME = 'claude';
const CLAUDE_MODEL  = 'claude-3-haiku-20240307';

/**
 * Generate a response using Claude 3 Haiku (last resort fallback).
 *
 * @param {string} prompt
 * @param {object} [options]
 * @returns {Promise<{ provider: string, text: string }>}
 */
async function generate(prompt, options = {}) {
  const apiKey = await getSecret('ANTHROPIC_API_KEY');

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model:      options.model || CLAUDE_MODEL,
    max_tokens: options.maxTokens || 2048,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = response?.content?.[0]?.text;

  if (!text || !text.trim()) {
    throw new Error('Claude returned an empty response');
  }

  logger.info(`[AI Router] ${PROVIDER_NAME} (last resort) responded successfully`);
  return { provider: PROVIDER_NAME, text };
}

module.exports = { generate, PROVIDER_NAME };








