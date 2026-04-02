'use strict';

/**
 * @file src/services/providers/openrouterService.js
 * @description
 * Production-grade OpenRouter provider.
 *
 * Optimized for:
 * - secret memoization
 * - dynamic model cost routing
 * - timeout-safe fetch
 * - latency observability
 * - usage extraction
 * - safe JSON parsing
 */

const { getSecret } = require('../../modules/secrets');
const logger = require('../../utils/logger');

const PROVIDER_NAME = 'openrouter';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const FAST_MODEL = 'meta-llama/llama-3.1-8b-instruct';
const LARGE_CONTEXT_MODEL = 'meta-llama/llama-3.1-70b-instruct';

const FETCH_TIMEOUT_MS = 25000;
const LARGE_PROMPT_THRESHOLD = 10000;

let cachedApiKey = null;

// ─────────────────────────────────────────────────────────────────────────────
// Secret memoization
// ─────────────────────────────────────────────────────────────────────────────
async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  cachedApiKey = await getSecret('OPENROUTER_API_KEY');
  return cachedApiKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic model routing
// ─────────────────────────────────────────────────────────────────────────────
function selectModel(prompt, options = {}) {
  if (options.model) return options.model;

  if (prompt.length >= LARGE_PROMPT_THRESHOLD) {
    return LARGE_CONTEXT_MODEL;
  }

  return FAST_MODEL;
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
// Provider generate
// ─────────────────────────────────────────────────────────────────────────────
async function generate(prompt, options = {}) {
  const startedAt = Date.now();
  const apiKey = await getApiKey();
  const model = selectModel(prompt, options);

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: options.maxTokens || 1024,
    temperature: options.temperature ?? 0.2,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;

  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.APP_URL || 'https://hirerise.app',
        'X-Title': 'HireRise AI',
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${response.status}: ${errorText}`);
  }

  const data = await safeJson(response);

  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('OpenRouter returned an empty response');
  }

  logger.info('[AI Router] OpenRouter success', {
    model,
    latency_ms: Date.now() - startedAt,
    prompt_chars: prompt.length,
    usage: data?.usage || null,
  });

  return {
    provider: PROVIDER_NAME,
    text,
    usage: data?.usage || null,
    model,
  };
}

module.exports = {
  generate,
  PROVIDER_NAME,
};