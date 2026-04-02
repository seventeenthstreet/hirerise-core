'use strict';

/**
 * @file src/services/aiRouter.js
 * @description
 * Production-grade multi-provider AI router.
 *
 * Optimized for:
 * - zero hot-path dynamic require
 * - timeout-safe provider execution
 * - health-aware failover
 * - prompt-size routing
 * - low-cost provider prioritization
 */

const logger = require('../utils/logger');

const PROVIDER_TIMEOUT_MS = Number(
  process.env.AI_PROVIDER_TIMEOUT_MS || 12000
);

const FAILURE_THRESHOLD = Number(
  process.env.AI_FAILURE_THRESHOLD || 3
);

const COOLDOWN_MS = Number(
  process.env.AI_COOLDOWN_MS || 5 * 60 * 1000
);

const LARGE_PROMPT_THRESHOLD = 12000;

// ─────────────────────────────────────────────────────────────────────────────
// Static provider loading (startup only)
// ─────────────────────────────────────────────────────────────────────────────
function safeLoad(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}

const providerModules = Object.freeze({
  OpenRouter: safeLoad('./providers/openrouterService'),
  Claude: safeLoad('./providers/claudeService'),
  Gemini: safeLoad('./providers/geminiService'),
  Fireworks: safeLoad('./providers/fireworksService'),
  Mistral: safeLoad('./providers/mistralService'),
});

function createProvider(name) {
  return {
    name,
    module: providerModules[name],
    health: {
      status: 'up',
      failures: 0,
      retryAfter: null,
    },
  };
}

const PROVIDERS = [
  createProvider('OpenRouter'),
  createProvider('Claude'),
  createProvider('Gemini'),
  createProvider('Fireworks'),
  createProvider('Mistral'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Health helpers
// ─────────────────────────────────────────────────────────────────────────────
function isAvailable(provider) {
  const health = provider.health;

  if (!provider.module) return false;
  if (health.status === 'up') return true;

  if (health.retryAfter && Date.now() >= health.retryAfter) {
    health.status = 'up';
    health.failures = 0;
    health.retryAfter = null;
    return true;
  }

  return false;
}

function recordFailure(provider) {
  provider.health.failures += 1;

  if (provider.health.failures >= FAILURE_THRESHOLD) {
    provider.health.status = 'down';
    provider.health.retryAfter = Date.now() + COOLDOWN_MS;

    logger.warn('[AI Router] Provider marked down', {
      provider: provider.name,
      cooldown_ms: COOLDOWN_MS,
    });
  }
}

function resetHealth(provider) {
  provider.health.status = 'up';
  provider.health.failures = 0;
  provider.health.retryAfter = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeout-safe execution
// ─────────────────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart provider routing
// ─────────────────────────────────────────────────────────────────────────────
function getProviderOrder(prompt, options = {}) {
  const promptLength = prompt.length;
  const modelHint = String(options.model || '').toLowerCase();

  // large grounded prompts → strongest context providers first
  if (promptLength >= LARGE_PROMPT_THRESHOLD) {
    return ['Claude', 'OpenRouter', 'Gemini', 'Mistral', 'Fireworks'];
  }

  // cost-optimized short prompts
  if (modelHint.includes('cheap') || promptLength < 4000) {
    return ['Gemini', 'Mistral', 'OpenRouter', 'Claude', 'Fireworks'];
  }

  return ['OpenRouter', 'Claude', 'Gemini', 'Mistral', 'Fireworks'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main router
// ─────────────────────────────────────────────────────────────────────────────
async function generateAIResponse(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('[AI Router] prompt must be a non-empty string');
  }

  let lastError = null;
  let anyAttempted = false;

  const providerOrder = getProviderOrder(prompt, options);

  for (const providerName of providerOrder) {
    const provider = PROVIDERS.find((item) => item.name === providerName);
    if (!provider || !isAvailable(provider)) continue;

    anyAttempted = true;

    try {
      const { generate } = provider.module;
      if (typeof generate !== 'function') {
        throw new Error(`${provider.name} missing generate()`);
      }

      const result = await withTimeout(
        generate(prompt, options),
        PROVIDER_TIMEOUT_MS,
        provider.name
      );

      if (!result?.text || typeof result.text !== 'string') {
        throw new Error(`${provider.name} returned invalid response`);
      }

      resetHealth(provider);

      logger.debug('[AI Router] Provider success', {
        provider: provider.name,
        prompt_length: prompt.length,
      });

      return result.text;
    } catch (error) {
      lastError = error;
      recordFailure(provider);

      logger.warn('[AI Router] Provider failed', {
        provider: provider.name,
        error: error.message,
      });
    }
  }

  logger.error('[AI Router] All providers failed', {
    attempted: anyAttempted,
    last_error: lastError?.message || null,
  });

  return 'AI service temporarily unavailable.';
}

function getProviderHealth() {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    status: provider.health.status,
    failures: provider.health.failures,
    retryAfter: provider.health.retryAfter
      ? new Date(provider.health.retryAfter).toISOString()
      : null,
    loaded: !!provider.module,
  }));
}

module.exports = {
  generateAIResponse,
  getProviderHealth,
};