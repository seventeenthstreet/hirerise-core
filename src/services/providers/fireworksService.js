'use strict';

/**
 * @file src/services/providers/fireworksService.js
 * @description
 * Fireworks AI provider used as fallback LLM route.
 *
 * Optimized for:
 * - secret memoization
 * - timeout protection
 * - structured error logging
 * - response validation
 * - usage extraction
 * - Supabase long-lived runtime safety
 */

const { getSecret } = require('../../modules/secrets');
const logger = require('../../utils/logger');

const PROVIDER_NAME = 'fireworks';
const FIREWORKS_URL =
  'https://api.fireworks.ai/inference/v1/chat/completions';

const DEFAULT_MODEL =
  'accounts/fireworks/models/llama-v3p1-70b-instruct';

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.3;
const REQUEST_TIMEOUT_MS = 20000;

let apiKeyPromise = null;

async function getApiKey() {
  if (!apiKeyPromise) {
    apiKeyPromise = getSecret('FIREWORKS_API_KEY');
  }

  try {
    const apiKey = await apiKeyPromise;

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('Missing Fireworks API key');
    }

    return apiKey;
  } catch (error) {
    apiKeyPromise = null;
    throw error;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Fireworks request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generate(prompt, options = {}) {
  const startedAt = Date.now();

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Fireworks prompt must be a non-empty string');
  }

  const apiKey = await getApiKey();

  const payload = {
    model: options.model || DEFAULT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: Number.isFinite(options.maxTokens)
      ? options.maxTokens
      : DEFAULT_MAX_TOKENS,
    temperature:
      typeof options.temperature === 'number'
        ? options.temperature
        : DEFAULT_TEMPERATURE,
  };

  try {
    const response = await fetchWithTimeout(
      FIREWORKS_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      options.timeoutMs || REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(
        `Fireworks HTTP ${response.status}: ${errBody}`
      );
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new Error('Fireworks AI returned an empty response');
    }

    logger.info('[AI Router] Fireworks success', {
      provider: PROVIDER_NAME,
      model: payload.model,
      latency_ms: Date.now() - startedAt,
      prompt_chars: prompt.length,
      usage: data?.usage ?? null,
    });

    return {
      provider: PROVIDER_NAME,
      text,
      usage: data?.usage ?? null,
      model: payload.model,
    };
  } catch (error) {
    logger.error('[AI Router] Fireworks failure', {
      provider: PROVIDER_NAME,
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