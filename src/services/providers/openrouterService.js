'use strict';

/**
 * openrouterService.js — OpenRouter Provider (EMERGENCY)
 * Model: meta-llama/llama-3.1-70b-instruct
 */

const { getSecret } = require('../../modules/secrets');
const logger        = require('../../utils/logger');

const PROVIDER_NAME    = 'openrouter';
const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';
// Updated to llama-3.1 — llama-3-70b-instruct is deprecated on some routes
const OPENROUTER_MODEL = 'meta-llama/llama-3.1-70b-instruct';
// OpenRouter can be slow for large prompts — 30s is safer than 12s
const FETCH_TIMEOUT_MS = 30000;

async function generate(prompt, options = {}) {
  const apiKey = await getSecret('OPENROUTER_API_KEY');

  const body = JSON.stringify({
    model:       options.model || OPENROUTER_MODEL,
    messages:    [{ role: 'user', content: prompt }],
    max_tokens:  options.maxTokens  || 2048,
    temperature: options.temperature != null ? options.temperature : 0.3,
  });

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.APP_URL || 'https://hirerise.app',
        'X-Title':      'HireRise AI',
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const text  = data?.choices?.[0]?.message?.content;

  if (!text || !text.trim()) throw new Error('OpenRouter returned an empty response');

  logger.info(`[AI Router] ${PROVIDER_NAME} responded successfully`);
  return { provider: PROVIDER_NAME, text };
}

module.exports = { generate, PROVIDER_NAME };








