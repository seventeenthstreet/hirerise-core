'use strict';

/**
 * mistralService.js — Mistral Small Provider (BACKUP)
 *
 * DEPENDENCY: @mistralai/mistralai
 *   Install with: npm install @mistralai/mistralai
 *   If absent, throws a clean error so the AI Router falls through.
 */

const { getSecret } = require('../../modules/secrets');
const logger        = require('../../utils/logger');

const PROVIDER_NAME = 'mistral';

async function generate(prompt, options = {}) {
  let Mistral;
  try {
    ({ Mistral } = require('@mistralai/mistralai'));
  } catch {
    throw new Error('Package @mistralai/mistralai is not installed. Run: npm install @mistralai/mistralai');
  }

  const apiKey = await getSecret('MISTRAL_API_KEY');
  const client = new Mistral({ apiKey });

  const result = await client.chat.complete({
    model:       options.model || 'mistral-small',
    messages:    [{ role: 'user', content: prompt }],
    maxTokens:   options.maxTokens  || 2048,
    temperature: options.temperature != null ? options.temperature : 0.3,
  });

  const text = result?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error('Mistral returned an empty response');

  logger.info(`[AI Router] ${PROVIDER_NAME} responded successfully`);
  return { provider: PROVIDER_NAME, text };
}

module.exports = { generate, PROVIDER_NAME };








