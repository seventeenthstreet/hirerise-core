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
 * - O(1) provider lookup
 * - stronger null safety
 * - cleaner modular provider registry
 * - consistent structured logging
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
  } catch (error) {
    logger.warn('[AI Router] Provider failed to load', {
      path,
      error: error?.message || 'Unknown module load error',
    });
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
    module: providerModules[name] || null,
    health: {
      status: 'up',
      failures: 0,
      retryAfter: null,
    },
  };
}

const PROVIDERS = Object.freeze([
  createProvider('OpenRouter'),
  createProvider('Claude'),
  createProvider('Gemini'),
  createProvider('Fireworks'),
  createProvider('Mistral'),
]);

const PROVIDER_MAP = new Map(
  PROVIDERS.map((provider) => [provider.name, provider])
);

// ─────────────────────────────────────────────────────────────────────────────
// Health helpers
// ─────────────────────────────────────────────────────────────────────────────
function isAvailable(provider) {
  if (!provider?.module) return false;

  const { health } = provider;

  if (health.status === 'up') {
    return true;
  }

  if (
    health.retryAfter &&
    Number.isFinite(health.retryAfter) &&
    Date.now() >= health.retryAfter
  ) {
    health.status = 'up';
    health.failures = 0;
    health.retryAfter = null;

    logger.info('[AI Router] Provider cooldown expired', {
      provider: provider.name,
    });

    return true;
  }

  return false;
}

function recordFailure(provider) {
  if (!provider) return;

  provider.health.failures += 1;

  if (provider.health.failures >= FAILURE_THRESHOLD) {
    provider.health.status = 'down';
    provider.health.retryAfter = Date.now() + COOLDOWN_MS;

    logger.warn('[AI Router] Provider marked down', {
      provider: provider.name,
      failures: provider.health.failures,
      cooldown_ms: COOLDOWN_MS,
    });
  }
}

function resetHealth(provider) {
  if (!provider) return;

  provider.health.status = 'up';
  provider.health.failures = 0;
  provider.health.retryAfter = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeout-safe execution
// ─────────────────────────────────────────────────────────────────────────────
function withTimeout(taskPromise, ms, label) {
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([taskPromise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart provider routing
// ─────────────────────────────────────────────────────────────────────────────
function getProviderOrder(prompt, options = {}) {
  const safePrompt = String(prompt || '');
  const promptLength = safePrompt.length;
  const modelHint = String(options?.model || '').toLowerCase();

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
  const safePrompt = String(prompt || '').trim();

  if (!safePrompt) {
    throw new Error('[AI Router] prompt must be a non-empty string');
  }

  let lastError = null;
  let anyAttempted = false;

  const providerOrder = getProviderOrder(safePrompt, options);

  for (const providerName of providerOrder) {
    const provider = PROVIDER_MAP.get(providerName);

    if (!provider || !isAvailable(provider)) {
      continue;
    }

    anyAttempted = true;

    try {
      const generateFn = provider.module?.generate;

      if (typeof generateFn !== 'function') {
        throw new Error(`${provider.name} missing generate()`);
      }

      const result = await withTimeout(
        Promise.resolve(generateFn(safePrompt, options)),
        PROVIDER_TIMEOUT_MS,
        provider.name
      );

      const text = result?.text;

      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${provider.name} returned invalid response`);
      }

      resetHealth(provider);

      logger.debug('[AI Router] Provider success', {
        provider: provider.name,
        prompt_length: safePrompt.length,
      });

      return text;
    } catch (error) {
      lastError = error;
      recordFailure(provider);

      logger.warn('[AI Router] Provider failed', {
        provider: provider.name,
        error: error?.message || 'Unknown provider error',
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
    loaded: Boolean(provider.module),
  }));
}

module.exports = {
  generateAIResponse,
  getProviderHealth,
};