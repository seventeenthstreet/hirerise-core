'use strict';

/**
 * @file src/modules/intelligenceProviders/intelligenceProviders.definitions.js
 *
 * WP-ADMIN-INTEL-06 — server-controlled definitions for the "Add Provider"
 * flow (admin-registered AI provider configuration).
 *
 * This is the single source of truth for:
 *   - which fields an admin-registered provider row may contain, and how
 *     each is validated;
 *   - which adapter protocols the UI may claim compatibility with
 *     (KNOWN_ADAPTER_TYPES) — mirrors the migration's
 *     `intelligence_provider_registry_adapter_type_allowlist` CHECK, which
 *     must be extended in lockstep with this file;
 *   - the fixed set of built-in provider keys that this flow can never
 *     create, rename, or shadow (they remain exclusively managed by
 *     `aiProviderManager.PROVIDER_ENV_KEYS` / `intelligenceSecrets.config.js`).
 *
 * IMPORTANT — registration vs. execution:
 * KNOWN_ADAPTER_TYPES lists the *protocols this codebase already has an
 * adapter implementation for* (see src/services/ai/providers/*.js), not
 * "any provider using this adapter_type is executable." Runtime execution
 * for resume extraction is still gated exclusively by
 * `aiProviderManager.PROVIDER_REGISTRY`, which only ever contains the five
 * built-in provider keys today — it is a static, code-defined map from
 * provider key to adapter module, not something this table can extend by
 * itself. A row created here is executable if and only if its
 * `provider_key` is *also* a key in PROVIDER_REGISTRY (see
 * intelligenceProviders.service.js's `isRuntimeSupported`). In practice
 * that means every genuinely new provider_key registered through this UI
 * reports `runtimeSupported: false` ("Adapter unavailable") until a
 * developer ships real adapter code for it — this module never invents
 * dynamic execution against an admin-supplied endpoint/model, per the
 * WP-ADMIN-INTEL-06 requirement.
 */

const { PROVIDER_REGISTRY: RUNTIME_ADAPTERS } = require('../../services/ai/aiProviderManager');

// ── Built-in providers — cannot be created/renamed/removed via this flow ──
const BUILTIN_PROVIDER_KEYS = Object.freeze(Object.keys(RUNTIME_ADAPTERS));

// ── Adapter protocols this codebase has real adapter code for ─────────────
// Mirrors the migration's CHECK constraint exactly.
const KNOWN_ADAPTER_TYPES = Object.freeze(['openai', 'anthropic', 'gemini', 'mistral', 'grok']);

const KNOWN_CREDENTIAL_TYPES = Object.freeze(['api_key']);

// provider_key: lowercase, starts with a letter, letters/digits/underscore,
// 2–40 chars total. Mirrors the migration's
// intelligence_provider_registry_key_format CHECK.
const PROVIDER_KEY_REGEX = /^[a-z][a-z0-9_]{1,39}$/;

const DISPLAY_NAME_MAX_LEN = 100;
const DEFAULT_MODEL_MAX_LEN = 200;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateProviderKey(rawKey) {
  if (!isNonEmptyString(rawKey)) {
    return { valid: false, error: 'Provider key is required.' };
  }
  const key = rawKey.trim().toLowerCase();
  if (!PROVIDER_KEY_REGEX.test(key)) {
    return {
      valid: false,
      error:
        'Provider key must start with a lowercase letter and contain only ' +
        'lowercase letters, digits, and underscores (2–40 characters).',
    };
  }
  if (BUILTIN_PROVIDER_KEYS.includes(key)) {
    return {
      valid: false,
      error: `'${key}' is a built-in provider and is already managed on this page.`,
      code: 'BUILTIN_PROVIDER_KEY',
    };
  }
  return { valid: true, normalized: key };
}

function validateDisplayName(raw) {
  if (!isNonEmptyString(raw)) {
    return { valid: false, error: 'Display name is required.' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > DISPLAY_NAME_MAX_LEN) {
    return { valid: false, error: `Display name must be ${DISPLAY_NAME_MAX_LEN} characters or fewer.` };
  }
  return { valid: true, normalized: trimmed };
}

function validateAdapterType(raw) {
  if (!isNonEmptyString(raw)) {
    return { valid: false, error: 'Adapter / protocol is required.' };
  }
  const value = raw.trim().toLowerCase();
  if (!KNOWN_ADAPTER_TYPES.includes(value)) {
    return {
      valid: false,
      error: `Unsupported adapter/protocol: '${value}'. Supported: ${KNOWN_ADAPTER_TYPES.join(', ')}.`,
    };
  }
  return { valid: true, normalized: value };
}

function validateEndpoint(raw) {
  // Optional field.
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, normalized: null };
  }
  if (typeof raw !== 'string') {
    return { valid: false, error: 'API endpoint must be a string.' };
  }
  const trimmed = raw.trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { valid: false, error: 'API endpoint must be a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { valid: false, error: 'API endpoint must use https://.' };
  }
  return { valid: true, normalized: url.toString() };
}

function validateDefaultModel(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, normalized: null };
  }
  if (typeof raw !== 'string') {
    return { valid: false, error: 'Default model must be a string.' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > DEFAULT_MODEL_MAX_LEN) {
    return { valid: false, error: `Default model must be ${DEFAULT_MODEL_MAX_LEN} characters or fewer.` };
  }
  return { valid: true, normalized: trimmed };
}

function validateCredentialType(raw) {
  const value = isNonEmptyString(raw) ? raw.trim().toLowerCase() : 'api_key';
  if (!KNOWN_CREDENTIAL_TYPES.includes(value)) {
    return {
      valid: false,
      error: `Unsupported credential type: '${value}'. Supported: ${KNOWN_CREDENTIAL_TYPES.join(', ')}.`,
    };
  }
  return { valid: true, normalized: value };
}

function validateEnabled(raw) {
  if (raw === undefined || raw === null) return { valid: true, normalized: true };
  if (typeof raw !== 'boolean') {
    return { valid: false, error: 'enabled must be a boolean.' };
  }
  return { valid: true, normalized: raw };
}

/**
 * Validate the full non-secret "Add Provider" payload. Does not touch the
 * credential — that is validated separately by the credential gateway
 * (never mixed with, or persisted alongside, non-secret config).
 */
function validateProviderInput(input, { partial = false } = {}) {
  const errors = {};
  const normalized = {};

  const fields = partial
    ? Object.keys(input || {})
    : ['providerKey', 'displayName', 'adapterType'];

  const validators = {
    providerKey: (v) => validateProviderKey(v),
    displayName: (v) => validateDisplayName(v),
    adapterType: (v) => validateAdapterType(v),
    apiEndpoint: (v) => validateEndpoint(v),
    defaultModel: (v) => validateDefaultModel(v),
    credentialType: (v) => validateCredentialType(v),
    enabled: (v) => validateEnabled(v),
  };

  // Always validate every recognized key present on the input, plus the
  // required-on-create fields even if absent (so "missing" surfaces as a
  // normal validation error, not a 500).
  const keysToCheck = new Set([...fields, ...Object.keys(input || {})]);

  for (const key of keysToCheck) {
    if (!validators[key]) continue; // unknown fields are ignored, never persisted
    if (partial && !Object.prototype.hasOwnProperty.call(input || {}, key)) continue;

    const result = validators[key](input ? input[key] : undefined);
    if (!result.valid) {
      errors[key] = result.error;
    } else {
      normalized[key] = result.normalized;
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized,
  };
}

module.exports = {
  BUILTIN_PROVIDER_KEYS,
  KNOWN_ADAPTER_TYPES,
  KNOWN_CREDENTIAL_TYPES,
  PROVIDER_KEY_REGEX,
  validateProviderKey,
  validateDisplayName,
  validateAdapterType,
  validateEndpoint,
  validateDefaultModel,
  validateCredentialType,
  validateEnabled,
  validateProviderInput,
};
