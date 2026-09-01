'use strict';

/**
 * @file src/modules/intelligenceConfig/intelligenceConfig.definitions.js
 *
 * WP-ADMIN-INTEL-04 — server-controlled definitions for ordinary,
 * non-secret Intelligence configuration.
 *
 * This is the single source of truth for which settings this
 * administration layer supports. Every other module in this feature
 * (repository, resolver, service, controller, DB CHECK constraint) treats
 * this list as the only valid set of keys:
 *   - the client can never write an arbitrary key (service layer rejects
 *     anything not in DEFINITIONS before touching the repository);
 *   - the database can never persist an arbitrary key even if application
 *     validation were somehow bypassed (see the migration's
 *     `intelligence_config_overrides_key_allowlist` CHECK constraint,
 *     which must be extended in lockstep with this file).
 *
 * Per the WP-ADMIN-INTEL-04 audit (Configuration Classification Matrix),
 * exactly one active, non-secret, admin-safe setting was verified today:
 * AI_PROVIDER_PRIORITY, the resume-extraction provider fallback order
 * consumed by src/services/ai/aiProviderManager.js. Every other
 * Intelligence-related environment variable discovered during the audit
 * (AI_PROVIDER_TIMEOUT_MS, AI_FAILURE_THRESHOLD, AI_COOLDOWN_MS,
 * ANTHROPIC_PREMIUM_MODEL, per-provider model identifiers, etc.) was
 * deliberately NOT promoted here — see the WP-ADMIN-INTEL-04 Completion
 * Report's Configuration Classification Matrix for the verified reason
 * in each case. Do not add an entry to this file without equivalent
 * verification; this registry existing is not itself justification for
 * adding more settings "to make the UI look complete."
 */

const {
  PROVIDER_REGISTRY,
  DEFAULT_PRIORITY,
} = require('../../services/ai/aiProviderManager');

// ── AI_PROVIDER_PRIORITY ────────────────────────────────────────────────────
//
// Ordered, comma-separated list of resume-extraction provider names.
// Validated against the same PROVIDER_REGISTRY aiProviderManager.js itself
// uses — this definition never declares a second, independent list of
// valid provider names.
function parseProviderList(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  return trimmed
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function validateProviderPriority(raw) {
  const entries = parseProviderList(raw);

  if (!entries || entries.length === 0) {
    return {
      valid: false,
      error: 'Value must be a non-empty comma-separated list of provider names.',
    };
  }

  const unknown = entries.filter(
    (name) => !Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, name)
  );
  if (unknown.length > 0) {
    return {
      valid: false,
      error: `Unknown provider(s): ${unknown.join(', ')}. Supported providers: ${Object.keys(PROVIDER_REGISTRY).join(', ')}.`,
    };
  }

  const seen = new Set();
  const duplicates = entries.filter((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
  if (duplicates.length > 0) {
    return {
      valid: false,
      error: `Duplicate provider(s) in list: ${[...new Set(duplicates)].join(', ')}.`,
    };
  }

  // Canonical stored form: normalized (trimmed, lowercased), re-joined.
  return { valid: true, normalized: entries.join(',') };
}

const DEFINITIONS = Object.freeze({
  AI_PROVIDER_PRIORITY: Object.freeze({
    key: 'AI_PROVIDER_PRIORITY',
    label: 'AI Provider Priority (Resume Extraction)',
    description:
      'Ordered fallback chain of AI providers used for structured resume ' +
      'extraction (src/services/ai/aiProviderManager.js). Comma-separated ' +
      'provider names, most-preferred first.',
    type: 'string',
    envVar: 'AI_PROVIDER_PRIORITY',
    // Imported directly from aiProviderManager.js (not redeclared here) so
    // this definition can never drift from the module it configures.
    codeDefault: DEFAULT_PRIORITY,
    allowedValues: Object.freeze(Object.keys(PROVIDER_REGISTRY)),
    emptyAllowed: false,
    validate: validateProviderPriority,
  }),
});

function isSupportedKey(key) {
  return (
    typeof key === 'string' &&
    Object.prototype.hasOwnProperty.call(DEFINITIONS, key)
  );
}

function listKeys() {
  return Object.keys(DEFINITIONS);
}

function getDefinition(key) {
  return DEFINITIONS[key] || null;
}

function assertSupportedKey(key) {
  if (!isSupportedKey(key)) {
    throw Object.assign(
      new Error(`Unsupported Intelligence configuration key: '${key}'.`),
      { status: 400, code: 'UNKNOWN_CONFIG_KEY' }
    );
  }
  return DEFINITIONS[key];
}

module.exports = {
  DEFINITIONS,
  isSupportedKey,
  listKeys,
  getDefinition,
  assertSupportedKey,
};
