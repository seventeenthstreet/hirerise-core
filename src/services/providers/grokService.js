'use strict';

/**
 * @file src/services/providers/grokService.js
 * @description
 * Production-grade xAI Grok provider.
 *
 * Uses xAI's OpenAI-compatible chat completions endpoint:
 * https://api.x.ai/v1/chat/completions
 *
 * Optimized for:
 * - concurrent-safe secret memoization
 * - dynamic model routing
 * - abortable timeout-safe fetch
 * - robust content extraction
 * - structured logging
 * - Supabase warm runtime safety
 */

const { getSecret } = require('../../modules/secrets');
const logger = require('../../utils/logger');

const PROVIDER_NAME = 'grok';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';

const FAST_MODEL = 'grok-4-1-fast';
const REASONING_MODEL = 'grok-4-1-fast-reasoning';

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.2;
const LARGE_PROMPT_THRESHOLD = 10_000;

let apiKeyPromise = null;

// ─────────────────────────────────────────────────────────────────────────────
// Secret memoization (concurrency-safe)
// ─────────────────────────────────────────────────────────────────────────────
async function getApiKey() {
  if (!apiKeyPromise) {
    apiKeyPromise = getSecret('XAI_API_KEY');
  }

  try {
    const apiKey = await apiKeyPromise;

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('Missing xAI API key');
    }

    return apiKey;
  } catch (error) {
    apiKeyPromise = null;
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic model routing
// ─────────────────────────────────────────────────────────────────────────────
function selectModel(prompt, options = {}) {
  if (options.model) {
    return options.model;
  }

  const promptLength =
    typeof prompt === 'string' ? prompt.length : 0;

  return promptLength >= LARGE_PROMPT_THRESHOLD
    ? REASONING_MODEL
    : FAST_MODEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe JSON parse
// ─────────────────────────────────────────────────────────────────────────────
async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Response extraction
// ─────────────────────────────────────────────────────────────────────────────
function extractText(data) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'string'
          ? block
          : typeof block?.text === 'string'
            ? block.text
            : ''
      )
      .join('\n')
      .trim();
  }

  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider generate
// ─────────────────────────────────────────────────────────────────────────────
async function generate(prompt, options = {}) {
  const startedAt = Date.now();

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Grok prompt must be a non-empty string');
  }

  const apiKey = await getApiKey();
  const model = selectModel(prompt, options);

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: Number.isFinite(options.maxTokens)
      ? options.maxTokens
      : DEFAULT_MAX_TOKENS,
    temperature:
      typeof options.temperature === 'number'
        ? options.temperature
        : DEFAULT_TEMPERATURE,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(XAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer':
          process.env.APP_URL || 'https://hirerise.app',
        'X-Title': 'HireRise AI',
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Grok HTTP ${response.status}: ${errorText}`);
    }

    const data = await safeJson(response);
    const text = extractText(data);

    if (!text) {
      throw new Error('Grok returned an empty response');
    }

    const usage = data?.usage ?? null;

    logger.info('[AI Router] Grok success', {
      provider: PROVIDER_NAME,
      model,
      latency_ms: Date.now() - startedAt,
      prompt_chars: prompt.length,
      usage,
    });

    return {
      provider: PROVIDER_NAME,
      text,
      usage,
      model,
    };
  } catch (error) {
    const normalizedError =
      controller.signal.aborted
        ? new Error('Grok request timed out')
        : error;

    logger.error('[AI Router] Grok failure', {
      provider: PROVIDER_NAME,
      model,
      latency_ms: Date.now() - startedAt,
      error: normalizedError.message,
    });

    throw normalizedError;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  generate,
  PROVIDER_NAME,
};