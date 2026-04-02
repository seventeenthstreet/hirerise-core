'use strict';

/**
 * @file src/services/providers/claudeService.js
 * @description
 * Production-grade Anthropic Claude provider.
 *
 * Optimized for:
 * - singleton SDK client
 * - secret memoization
 * - dynamic premium model routing
 * - timeout protection
 * - token usage extraction
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSecret } = require('../../modules/secrets');
const logger = require('../../utils/logger');

const PROVIDER_NAME = 'claude';

const FAST_MODEL = 'claude-3-haiku-20240307';
const LARGE_CONTEXT_MODEL =
  process.env.ANTHROPIC_PREMIUM_MODEL || 'claude-sonnet-4-20250514';

const LARGE_PROMPT_THRESHOLD = 10000;
const REQUEST_TIMEOUT_MS = 20000;

let cachedApiKey = null;
let cachedClient = null;

// ─────────────────────────────────────────────────────────────────────────────
// Singleton client
// ─────────────────────────────────────────────────────────────────────────────
async function getClient() {
  if (cachedClient) return cachedClient;

  if (!cachedApiKey) {
    cachedApiKey = await getSecret('ANTHROPIC_API_KEY');
  }

  cachedClient = new Anthropic({
    apiKey: cachedApiKey,
  });

  return cachedClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model routing
// ─────────────────────────────────────────────────────────────────────────────
function selectModel(prompt, options = {}) {
  if (options.model) return options.model;

  if (prompt.length >= LARGE_PROMPT_THRESHOLD) {
    return LARGE_CONTEXT_MODEL;
  }

  return FAST_MODEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeout wrapper
// ─────────────────────────────────────────────────────────────────────────────
function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Claude request timed out'));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate
// ─────────────────────────────────────────────────────────────────────────────
async function generate(prompt, options = {}) {
  const startedAt = Date.now();
  const client = await getClient();
  const model = selectModel(prompt, options);

  const response = await withTimeout(
    client.messages.create({
      model,
      max_tokens: options.maxTokens || 1024,
      temperature: options.temperature ?? 0.2,
      messages: [{ role: 'user', content: prompt }],
    })
  );

  const text = response?.content?.[0]?.text;

  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('Claude returned an empty response');
  }

  logger.info('[AI Router] Claude success', {
    model,
    latency_ms: Date.now() - startedAt,
    prompt_chars: prompt.length,
    usage: response?.usage || null,
  });

  return {
    provider: PROVIDER_NAME,
    text,
    usage: response?.usage || null,
    model,
  };
}

module.exports = {
  generate,
  PROVIDER_NAME,
};