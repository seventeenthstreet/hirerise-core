'use strict';

/**
 * @file src/services/providers/mistralService.js
 * @description
 * Mistral Small provider (BACKUP)
 *
 * Optimized for:
 * - singleton SDK reuse
 * - secret memoization
 * - timeout protection
 * - robust content extraction
 * - structured logging
 * - Supabase warm runtime safety
 */

const logger = require('../../utils/logger');
const { getSecret } = require('../../modules/secrets');

let Mistral;

try {
  ({ Mistral } = require('@mistralai/mistralai'));
} catch {
  Mistral = null;
}

const PROVIDER_NAME = 'mistral';
const DEFAULT_MODEL = 'mistral-small';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.3;
const REQUEST_TIMEOUT_MS = 20000;

let apiKeyPromise = null;
let clientPromise = null;

async function getClient() {
  if (!Mistral) {
    throw new Error(
      'Package @mistralai/mistralai is not installed. Run: npm install @mistralai/mistralai'
    );
  }

  if (clientPromise) {
    return clientPromise;
  }

  clientPromise = (async () => {
    if (!apiKeyPromise) {
      apiKeyPromise = getSecret('MISTRAL_API_KEY');
    }

    const apiKey = await apiKeyPromise;

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('Missing Mistral API key');
    }

    return new Mistral({ apiKey });
  })();

  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    apiKeyPromise = null;
    throw error;
  }
}

async function withTimeout(promise, timeoutMs) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Mistral request timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractText(result) {
  const content = result?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof part?.text === 'string'
            ? part.text
            : ''
      )
      .join('\n')
      .trim();
  }

  return '';
}

async function generate(prompt, options = {}) {
  const startedAt = Date.now();

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Mistral prompt must be a non-empty string');
  }

  const client = await getClient();
  const model = options.model || DEFAULT_MODEL;

  try {
    const result = await withTimeout(
      client.chat.complete({
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: Number.isFinite(options.maxTokens)
          ? options.maxTokens
          : DEFAULT_MAX_TOKENS,
        temperature:
          typeof options.temperature === 'number'
            ? options.temperature
            : DEFAULT_TEMPERATURE,
      }),
      options.timeoutMs || REQUEST_TIMEOUT_MS
    );

    const text = extractText(result);

    if (!text) {
      throw new Error('Mistral returned an empty response');
    }

    logger.info('[AI Router] Mistral success', {
      provider: PROVIDER_NAME,
      model,
      latency_ms: Date.now() - startedAt,
      prompt_chars: prompt.length,
    });

    return {
      provider: PROVIDER_NAME,
      text,
      model,
    };
  } catch (error) {
    logger.error('[AI Router] Mistral failure', {
      provider: PROVIDER_NAME,
      model,
      latency_ms: Date.now() - startedAt,
      error: error.message,
    });

    throw error;
  }
}

module.exports = {
  generate,
  PROVIDER_NAME,
};