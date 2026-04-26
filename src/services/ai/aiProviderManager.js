'use strict';

/**
 * @file src/services/ai/aiProviderManager.js
 * @description
 * Centralized AI Provider Manager for structured resume extraction.
 *
 * Architecture:
 *   - Priority-ordered provider chain (configurable via AI_PROVIDER_PRIORITY)
 *   - Per-provider API key gating (skips unconfigured providers instantly)
 *   - Structured result validation before accepting a response
 *   - Full error isolation: one provider crashing never affects the next
 *   - Zero crash guarantee: always returns null rather than throwing
 *
 * Default priority: gemini → grok → mistral → openai → anthropic
 *
 * Usage:
 *   const { extractResumeWithFallback } = require('./aiProviderManager');
 *   const result = await extractResumeWithFallback(resumeText);
 *   // result is { name, email, skills, experience, education } or null
 */

const logger = require('../../utils/logger');

// ── Provider registry ──────────────────────────────────────────────────────────
// Each provider module must export: { extractResume(text): Promise<object|null>, PROVIDER_NAME: string }

const PROVIDER_REGISTRY = {
  gemini:    () => require('./providers/gemini'),
  grok:      () => require('./providers/grok'),
  mistral:   () => require('./providers/mistral'),
  openai:    () => require('./providers/openai'),
  anthropic: () => require('./providers/anthropic'),
};

// ── API key env var mapping ────────────────────────────────────────────────────
// Maps provider name → expected environment variable(s).
// The manager checks these synchronously to skip unconfigured providers fast.
// Grok supports both GROK_API_KEY (project convention) and XAI_API_KEY.

const PROVIDER_ENV_KEYS = {
  gemini:    ['GEMINI_API_KEY'],
  grok:      ['GROK_API_KEY', 'XAI_API_KEY'],
  mistral:   ['MISTRAL_API_KEY'],
  openai:    ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
};

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_PRIORITY     = 'gemini,grok,mistral,openai,anthropic';
const MAX_RESUME_TEXT_LEN  = 5_000; // hard cap to control token costs

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Determine whether an AI extraction result is valid enough to accept.
 *
 * Accepts the result when EITHER:
 *   - skills array has ≥ 3 entries  (mirrors isWeakParse in aiExtractor.service.js)
 *   - experience array has ≥ 1 entry
 *
 * @param {*} result
 * @returns {boolean}
 */
function isValidAIResult(result) {
  return (
    result !== null &&
    result !== undefined &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (
      (Array.isArray(result.skills)     && result.skills.length     >= 3) ||
      (Array.isArray(result.experience) && result.experience.length >= 1)
    )
  );
}

// ── Provider key check ─────────────────────────────────────────────────────────

/**
 * Check whether at least one env var for this provider is set.
 * Fast synchronous check — avoids async secret resolution for unconfigured providers.
 *
 * @param {string} providerName
 * @returns {boolean}
 */
function hasApiKey(providerName) {
  const envVars = PROVIDER_ENV_KEYS[providerName] ?? [];
  return envVars.some(key => {
    const val = process.env[key];
    return typeof val === 'string' && val.trim().length > 0;
  });
}

// ── Priority resolution ────────────────────────────────────────────────────────

/**
 * Return the ordered list of provider names to attempt.
 * Reads AI_PROVIDER_PRIORITY env var, falls back to DEFAULT_PRIORITY.
 * Filters out unknown provider names.
 *
 * @returns {string[]}
 */
function getProviderPriority() {
  const raw = (process.env.AI_PROVIDER_PRIORITY ?? DEFAULT_PRIORITY).trim();

  return raw
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0 && p in PROVIDER_REGISTRY);
}

// ── Core export ───────────────────────────────────────────────────────────────

/**
 * Attempt resume extraction using providers in priority order.
 *
 * For each provider the manager will:
 *   1. Check that an API key is present in env (skip if not)
 *   2. Dynamically load the provider module
 *   3. Call provider.extractResume(text)
 *   4. Validate the result via isValidAIResult()
 *   5. Return immediately on first valid result
 *
 * Returns null if every configured provider fails or produces an invalid result.
 *
 * @param {string} resumeText  - Raw extracted text from PDF / DOCX
 * @returns {Promise<{
 *   name: string|null,
 *   email: string|null,
 *   skills: string[],
 *   experience: Array<{title,company,start_date,end_date,description}>,
 *   education: Array<{degree,institution,startYear,endYear}>
 * }|null>}
 */
async function extractResumeWithFallback(resumeText) {
  // ── Input guard ────────────────────────────────────────────────────────────
  if (typeof resumeText !== 'string' || !resumeText.trim()) {
    logger.warn('[AIProviderManager] extractResumeWithFallback called with empty text');
    return null;
  }

  // Safety: truncate to avoid excessive token cost across all providers
  const text = resumeText.slice(0, MAX_RESUME_TEXT_LEN);

  const priority = getProviderPriority();

  if (priority.length === 0) {
    logger.error('[AIProviderManager] No valid providers configured in AI_PROVIDER_PRIORITY');
    return null;
  }

  // ── Provider loop ──────────────────────────────────────────────────────────
  for (const providerName of priority) {
    // ── Key check ────────────────────────────────────────────────────────────
    if (!hasApiKey(providerName)) {
      logger.warn(`[AIProviderManager] Skipping provider: ${providerName} — API key not set`);
      continue;
    }

    logger.info(`[AIProviderManager] Trying provider: ${providerName}`);

    // ── Load provider ─────────────────────────────────────────────────────────
    let provider;
    try {
      provider = PROVIDER_REGISTRY[providerName]();
    } catch (loadErr) {
      logger.error(`[AIProviderManager] Failed to load provider module: ${providerName}`, {
        error: loadErr.message,
      });
      logger.warn(`[AIProviderManager] Provider failed: ${providerName}`);
      continue;
    }

    // ── Call provider ─────────────────────────────────────────────────────────
    let result = null;
    try {
      result = await provider.extractResume(text);
    } catch (callErr) {
      // Providers should catch their own errors and return null,
      // but we double-catch here as the final safety net.
      logger.error(`[AIProviderManager] Unexpected error in provider: ${providerName}`, {
        error: callErr.message,
      });
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    if (isValidAIResult(result)) {
      logger.info(`[AIProviderManager] Success with: ${providerName}`, {
        skills:     result.skills.length,
        experience: result.experience.length,
        education:  result.education.length,
      });
      return result;
    }

    logger.warn(`[AIProviderManager] Provider failed: ${providerName}`, {
      reason: result === null
        ? 'provider returned null'
        : `result invalid (skills=${result?.skills?.length ?? 0}, experience=${result?.experience?.length ?? 0})`,
    });
  }

  // ── All providers exhausted ────────────────────────────────────────────────
  logger.error('[AIProviderManager] All providers failed — returning null');
  return null;
}

// ── Named exports ──────────────────────────────────────────────────────────────
module.exports = Object.freeze({
  extractResumeWithFallback,
  isValidAIResult,
  getProviderPriority,   // exported for testing / introspection
  PROVIDER_REGISTRY,     // exported for extensibility
  PROVIDER_ENV_KEYS,     // exported for extensibility
});