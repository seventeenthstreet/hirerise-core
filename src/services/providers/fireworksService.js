'use strict';

/**
 * fireworksService.js — Fireworks AI Provider (FALLBACK)
 * Model: Llama 3.1 70B Instruct
 */

const { getSecret } = require('../../modules/secrets');
const logger        = require('../../utils/logger');

const PROVIDER_NAME   = 'fireworks';
const FIREWORKS_URL   = 'https://api.fireworks.ai/inference/v1/chat/completions';
// llama-v3p1-70b-instruct replaces the retired llama-v3-70b-instruct
const FIREWORKS_MODEL = 'accounts/fireworks/models/llama-v3p1-70b-instruct';

async function generate(prompt, options = {}) {
  const apiKey = await getSecret('FIREWORKS_API_KEY');

  const body = JSON.stringify({
    model:       options.model || FIREWORKS_MODEL,
    messages:    [{ role: 'user', content: prompt }],
    max_tokens:  options.maxTokens  || 2048,
    temperature: options.temperature != null ? options.temperature : 0.3,
  });

  const response = await fetch(FIREWORKS_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Fireworks AI HTTP ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const text  = data?.choices?.[0]?.message?.content;

  if (!text || !text.trim()) throw new Error('Fireworks AI returned an empty response');

  logger.info(`[AI Router] ${PROVIDER_NAME} responded successfully`);
  return { provider: PROVIDER_NAME, text };
}

module.exports = { generate, PROVIDER_NAME };








