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

// ── Optional Secrets Manager fallback ────────────────────────────────────────
// WP-ADMIN-INTEL-03 (G6 fix): hasApiKey() previously checked only
// process.env, even though every provider module below (providers/*.js)
// already falls back to getSecret() when its env var isn't set. That meant
// a provider configured *only* through the Secrets Manager was skipped by
// this pre-check before its own module ever got a chance to resolve the
// credential — this optional require mirrors the exact guarded pattern
// each provider module already uses, so hasApiKey()'s precedence matches
// theirs (env first, Secrets Manager fallback) instead of diverging from it.
let getSecret = null;
try {
  ({ getSecret } = require('../../modules/secrets'));
} catch { /* secrets module unavailable — env-only fallback, unchanged behavior */ }

// ── Optional Intelligence configuration resolver (WP-ADMIN-INTEL-04) ────────
// Adds an administrative-override tier on top of the existing env/default
// precedence for AI_PROVIDER_PRIORITY.
//
// Deliberately NOT required at module top-level like getSecret above:
// intelligenceConfig.definitions.js itself requires THIS module (for
// PROVIDER_REGISTRY / DEFAULT_PRIORITY), so a top-level require here would
// create a circular require that resolves to an empty object on the
// definitions side (Node returns the in-progress, not-yet-populated
// module.exports of a module that is still executing further up the same
// require chain). Requiring lazily inside extractResumeWithFallback()
// instead means the resolver is only ever loaded after THIS module has
// already finished executing top-to-bottom at least once — breaking the
// cycle. Node's require cache still makes every call after the first one
// free. Optional-require, same guarded pattern as getSecret: if the config
// module is unavailable for any reason, priority falls back to the
// original, unchanged getProviderPriority() (env → DEFAULT_PRIORITY) —
// this file's pre-existing behavior is fully preserved either way.
function loadPriorityResolver() {
  try {
    return require('../../modules/intelligenceConfig/intelligenceConfig.resolver').resolveProviderPriority;
  } catch {
    return null;
  }
}

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
 * Check whether env vars for this provider are set. Synchronous, cheap —
 * the common case (env-configured provider) never touches the Secrets
 * Manager.
 *
 * @param {string} providerName
 * @returns {boolean}
 */
function hasEnvApiKey(providerName) {
  const envVars = PROVIDER_ENV_KEYS[providerName] ?? [];
  return envVars.some(key => {
    const val = process.env[key];
    return typeof val === 'string' && val.trim().length > 0;
  });
}

/**
 * Determine whether a provider is available to attempt, in a way that is
 * consistent with each provider module's own credential-resolution
 * precedence (env first, Secrets Manager fallback) — see G6 fix note above.
 *
 * This never returns or logs the credential itself, only a boolean: the
 * caller (extractResumeWithFallback) uses this purely to decide whether to
 * bother loading + calling the provider module, which independently
 * re-resolves and uses the actual credential.
 *
 * @param {string} providerName
 * @returns {Promise<boolean>}
 */
async function hasApiKey(providerName) {
  if (hasEnvApiKey(providerName)) return true;

  if (typeof getSecret !== 'function') return false;

  const envVars = PROVIDER_ENV_KEYS[providerName] ?? [];
  for (const key of envVars) {
    try {
      const secret = await getSecret(key);
      if (typeof secret === 'string' && secret.trim().length > 0) {
        return true;
      }
    } catch {
      // Not found / lookup failed for this name — fail safe, try the next
      // alias (if any) rather than throwing out of an availability check.
    }
  }

  return false;
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
 *   1. Check that a credential is available — env first, then the Secrets
 *      Manager (skip if neither has one; see hasApiKey() / G6 fix note)
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

  // WP-ADMIN-INTEL-04: resolve through the full admin-override → env →
  // code-default precedence when the config resolver is available; falls
  // back to the original env/default-only getProviderPriority() otherwise
  // (module unavailable, or the resolver itself fails — resolveProviderPriority()
  // is already fail-safe internally, but this is a second, outer safety net
  // so a problem in that optional module can never break resume extraction).
  let priority;
  const resolvePriority = loadPriorityResolver();
  if (resolvePriority) {
    try {
      priority = await resolvePriority();
    } catch (resolverErr) {
      logger.warn('[AIProviderManager] Config resolver failed — using env/default priority', {
        error: resolverErr.message,
      });
      priority = getProviderPriority();
    }
  } else {
    priority = getProviderPriority();
  }

  if (!Array.isArray(priority) || priority.length === 0) {
    logger.error('[AIProviderManager] No valid providers configured in AI_PROVIDER_PRIORITY');
    return null;
  }

  // ── Provider loop ──────────────────────────────────────────────────────────
  for (const providerName of priority) {
    // ── Key check ────────────────────────────────────────────────────────────
    if (!(await hasApiKey(providerName))) {
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
  hasApiKey,              // exported for testing / introspection (async, G6 fix)
  getProviderPriority,    // exported for testing / introspection
  PROVIDER_REGISTRY,      // exported for extensibility
  PROVIDER_ENV_KEYS,      // exported for extensibility
  DEFAULT_PRIORITY,       // WP-ADMIN-INTEL-04: exported (read-only, string
                          // constant) so the Intelligence configuration
                          // registry can report the true code-default tier
                          // without redeclaring this value a second time.
                          // Purely additive — does not change any existing
                          // behavior of this module.
});