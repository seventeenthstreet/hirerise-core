'use strict';

/**
 * aiRouter.js — Multi-Provider AI Router
 *
 * Routes AI generation requests through a waterfall of providers,
 * automatically failing over on error or when a provider is marked
 * temporarily unhealthy.
 *
 * PROVIDER ORDER (tried in sequence):
 *   1. Gemini 1.5 Flash         — PRIMARY
 *   2. Fireworks AI / Llama 3   — FALLBACK
 *   3. Mistral Small            — BACKUP
 *   4. OpenRouter / Llama 3     — EMERGENCY
 *   5. Claude 3 Haiku           — LAST RESORT
 *
 * HEALTH TRACKING:
 *   Each provider has a lightweight in-memory health record.
 *   After FAILURE_THRESHOLD consecutive failures the provider is marked
 *   "down" for COOLDOWN_MS (5 min by default). During that window the
 *   router skips it entirely so a degraded provider does not slow the chain.
 *   Health resets automatically once the cooldown expires.
 *
 * TIMEOUT:
 *   Every provider call is raced against a configurable deadline
 *   (default 12 s). A timed-out call counts as a failure.
 *
 * RESPONSE CONTRACT:
 *   generateAIResponse() always returns a plain string. The per-provider
 *   { provider, text } object is unwrapped here; callers never see it.
 *   On total failure the safe fallback string is returned so the server
 *   never crashes.
 *
 * API KEY SECURITY:
 *   Keys are fetched from the Secret Manager inside each provider module.
 *   This file never reads process.env for key material.
 *
 * @module services/aiRouter
 */

const logger = require('../utils/logger');

// ─── Configuration ────────────────────────────────────────────────────────────

/** ms before a provider call is considered timed out (default 12 s) */
const PROVIDER_TIMEOUT_MS = parseInt(
  process.env.AI_PROVIDER_TIMEOUT_MS || '12000', 10
);

/** Consecutive failures before a provider is marked down */
const FAILURE_THRESHOLD = parseInt(
  process.env.AI_FAILURE_THRESHOLD || '3', 10
);

/** How long (ms) a failed provider stays in the "down" state (default 5 min) */
const COOLDOWN_MS = parseInt(
  process.env.AI_COOLDOWN_MS || String(5 * 60 * 1000), 10
);

// ─── Provider Registry ────────────────────────────────────────────────────────

/**
 * Ordered list of providers. `health` is mutable in-process state.
 * It resets on process restart, giving every provider a clean slate.
 */
// Provider order: OpenRouter first (working), then Claude (if key set),
// then Gemini/Fireworks/Mistral only if their env keys are present.
// This avoids burning through 3 failing providers on every request.
const PROVIDERS = [
  {
    name:    'OpenRouter',
    service: () => require('./providers/openrouterService'),
    health:  { status: 'up', failures: 0, retryAfter: null },
  },
  {
    name:    'Claude',
    service: () => require('./providers/claudeService'),
    health:  { status: 'up', failures: 0, retryAfter: null },
  },
  // Gemini, Fireworks, Mistral kept as last-resort fallbacks.
  // They will be skipped automatically if their API keys are missing
  // (getSecret throws → router marks them failed and moves on).
  {
    name:    'Gemini',
    service: () => require('./providers/geminiService'),
    health:  { status: 'up', failures: 0, retryAfter: null },
  },
  {
    name:    'Fireworks',
    service: () => require('./providers/fireworksService'),
    health:  { status: 'up', failures: 0, retryAfter: null },
  },
  {
    name:    'Mistral',
    service: () => require('./providers/mistralService'),
    health:  { status: 'up', failures: 0, retryAfter: null },
  },
];

// ─── Health Helpers ───────────────────────────────────────────────────────────

/**
 * Returns true if the provider can be tried right now.
 * Auto-recovers when the cooldown window has elapsed.
 */
function isAvailable(health) {
  if (health.status === 'up') return true;

  if (health.retryAfter !== null && Date.now() >= health.retryAfter) {
    health.status     = 'up';
    health.failures   = 0;
    health.retryAfter = null;
    return true;
  }

  return false;
}

/** Increment the failure counter; mark provider down at the threshold. */
function recordFailure(provider) {
  provider.health.failures += 1;

  if (provider.health.failures >= FAILURE_THRESHOLD) {
    provider.health.status     = 'down';
    provider.health.retryAfter = Date.now() + COOLDOWN_MS;

    logger.warn(
      '[AI Router] ' + provider.name + ' marked DOWN after ' +
      provider.health.failures + ' consecutive failures — ' +
      'cooldown ' + (COOLDOWN_MS / 1000) + 's'
    );
  }
}

/** Reset failure state after a successful call. */
function resetHealth(provider) {
  provider.health.status     = 'up';
  provider.health.failures   = 0;
  provider.health.retryAfter = null;
}

// ─── Timeout Helper ───────────────────────────────────────────────────────────

/** Race a promise against a timeout deadline. */
function withTimeout(promise, ms, label) {
  const deadline = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(label + ' timed out after ' + ms + 'ms')),
      ms
    )
  );
  return Promise.race([promise, deadline]);
}

// ─── Main Router ──────────────────────────────────────────────────────────────

/**
 * Generate an AI response, automatically falling back across providers.
 *
 * @param {string} prompt     — Full prompt string (system + user combined).
 * @param {object} [options]  — Optional hints: { maxTokens, temperature, model }
 * @returns {Promise<string>} — Plain text from the first successful provider,
 *                              or safe fallback if all fail.
 */
async function generateAIResponse(prompt, options) {
  options = options || {};

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('[AI Router] prompt must be a non-empty string');
  }

  let lastError;
  let anyAttempted = false;

  for (let i = 0; i < PROVIDERS.length; i++) {
    const provider = PROVIDERS[i];
    const nextName = PROVIDERS[i + 1] ? PROVIDERS[i + 1].name : null;

    // ── Health gate ────────────────────────────────────────────────────
    if (!isAvailable(provider.health)) {
      const secondsLeft = Math.ceil(
        (provider.health.retryAfter - Date.now()) / 1000
      );
      logger.warn(
        '[AI Router] ' + provider.name + ' is DOWN — skipping ' +
        '(' + secondsLeft + 's cooldown remaining)'
      );
      continue;
    }

    anyAttempted = true;

    // ── Call with timeout ──────────────────────────────────────────────
    try {
      const { generate } = provider.service();

      const result = await withTimeout(
        generate(prompt, options),
        PROVIDER_TIMEOUT_MS,
        provider.name
      );

      // Validate standardized response
      if (!result || typeof result.text !== 'string' || !result.text.trim()) {
        throw new Error(provider.name + ' returned an invalid response object');
      }

      resetHealth(provider);
      return result.text;

    } catch (err) {
      lastError = err;
      recordFailure(provider);

      if (nextName) {
        logger.warn(
          '[AI Router] ' + provider.name + ' failed → switching to ' +
          nextName + '. Reason: ' + err.message
        );
      } else {
        logger.error(
          '[AI Router] ' + provider.name + ' failed (last provider). ' +
          'Reason: ' + err.message
        );
      }
    }
  }

  // ── All providers exhausted ────────────────────────────────────────────────
  if (!anyAttempted) {
    logger.error('[AI Router] All providers are currently DOWN — none attempted');
  } else {
    logger.error('[AI Router] All providers failed. Returning safe fallback.', {
      lastError: lastError ? lastError.message : 'unknown',
    });
  }

  return 'AI service temporarily unavailable.';
}

// ─── Health Snapshot ──────────────────────────────────────────────────────────

/**
 * Return a read-only snapshot of the current provider health state.
 * Safe to expose via internal admin / health-check endpoints.
 *
 * @returns {Array<{ name, status, failures, retryAfter }>}
 */
function getProviderHealth() {
  return PROVIDERS.map(function (p) {
    return {
      name:       p.name,
      status:     p.health.status,
      failures:   p.health.failures,
      retryAfter: p.health.retryAfter
        ? new Date(p.health.retryAfter).toISOString()
        : null,
    };
  });
}

module.exports = { generateAIResponse, getProviderHealth };








