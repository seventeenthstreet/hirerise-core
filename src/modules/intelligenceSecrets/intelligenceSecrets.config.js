'use strict';

/**
 * @file src/modules/intelligenceSecrets/intelligenceSecrets.config.js
 *
 * WP-ADMIN-INTEL-03 — Intelligence Secret Configuration Gateway.
 *
 * This is the *only* module allowed to call the canonical Secrets Manager
 * (`getSecret` / `upsertSecret` / `getSecretStatus` / `deleteSecret`) on
 * behalf of AI provider credentials. It mirrors the precedent already
 * established by `marketIntelligence.config.js`: domain code (routes /
 * controller / service) never touches `secrets.service` directly, so
 * secrets I/O for a domain lives in exactly one place.
 *
 * No new vault, table, or encryption scheme is introduced here — every
 * read/write below delegates to the existing AES-256-GCM + HMAC secrets
 * store via `../secrets/secrets.service`.
 *
 * Provider identity and the canonical secret name per provider are NOT
 * accepted from the browser. Both are derived server-side from
 * `aiProviderManager.PROVIDER_ENV_KEYS` — the same registry the
 * resume-extraction fallback chain already uses to decide which env vars
 * (and, via each provider module's own `resolveApiKey()`, which
 * Secrets-Manager entries) belong to which provider. Deriving from that
 * registry, rather than declaring a second parallel list here, means this
 * gateway can never be pointed at a secret name the AI provider layer
 * doesn't already own, and there is only one place a new provider needs to
 * be registered.
 */

const logger = require('../../utils/logger');
const {
  upsertSecret,
  getSecretStatus,
  deleteSecret,
} = require('../secrets/secrets.service');
const { PROVIDER_ENV_KEYS } = require('../../services/ai/aiProviderManager');

// ─────────────────────────────────────────────────────────────────────────────
// Server-controlled provider registry
// ─────────────────────────────────────────────────────────────────────────────
//
// canonicalName — the first env var each provider module checks (see
//   src/services/ai/providers/*.js resolveApiKey()); this is also the only
//   secret name this gateway will ever write to.
// aliasNames    — any additional env var / Secrets-Manager name the same
//   provider module also accepts. Verified today: grok.js only
//   (GROK_API_KEY canonical, XAI_API_KEY alias — see grok.js resolveApiKey()).
//   Aliases are read-only here (used to answer "is this provider already
//   configured under its legacy name" for status), never written.
const PROVIDERS = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_ENV_KEYS).map(([provider, envVars]) => [
      provider,
      Object.freeze({
        canonicalName: envVars[0],
        aliasNames: Object.freeze(envVars.slice(1)),
      }),
    ])
  )
);

function isSupportedProvider(provider) {
  return (
    typeof provider === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDERS, provider)
  );
}

function listProviderIds() {
  return Object.keys(PROVIDERS);
}

/**
 * Resolve a provider id to its registry entry, or throw a safe 400.
 * This is the single choke point that keeps arbitrary client-supplied
 * strings from ever reaching a Secrets Manager call.
 */
function assertSupportedProvider(provider) {
  if (!isSupportedProvider(provider)) {
    throw Object.assign(
      new Error(`Unsupported Intelligence provider: '${provider}'.`),
      { status: 400, code: 'UNKNOWN_PROVIDER' }
    );
  }
  return PROVIDERS[provider];
}

function isEnvConfigured(envVars) {
  return envVars.some((key) => {
    const val = process.env[key];
    return typeof val === 'string' && val.trim().length > 0;
  });
}

/**
 * Checks the Secrets Manager for *existence* of any of the given names —
 * canonical first, then aliases. Never decrypts a value (uses
 * getSecretStatus, not getSecret): this function answers "is something
 * configured", not "what is it".
 */
async function isSecretsManagerConfigured(names) {
  for (const name of names) {
    try {
      await getSecretStatus(name);
      return true;
    } catch (err) {
      if (err?.status !== 404) {
        // Unexpected lookup failure (DB error, etc). Fail safe: never
        // throw out of a status check and never surface a credential —
        // just log and treat this name as not-confirmed-configured.
        logger.warn('[IntelligenceSecrets] Secret status lookup failed', {
          name,
          error: err?.message,
        });
      }
    }
  }
  return false;
}

/**
 * Safe, non-plaintext status for a single provider. Only returns booleans
 * and the (non-secret) canonical secret name — never a value, ciphertext,
 * IV, auth tag, or HMAC.
 */
async function getProviderStatus(provider) {
  const { canonicalName, aliasNames } = assertSupportedProvider(provider);
  const allNames = [canonicalName, ...aliasNames];

  const [environmentConfigured, secretsManagerHasEntry] = await Promise.all([
    isEnvConfigured(allNames),
    isSecretsManagerConfigured(allNames),
  ]);

  return {
    provider,
    secretName: canonicalName,
    environmentConfigured,
    secretsManagerConfigured: secretsManagerHasEntry,
    configured: environmentConfigured || secretsManagerHasEntry,
  };
}

async function listProviderStatuses() {
  return Promise.all(listProviderIds().map(getProviderStatus));
}

/**
 * Store/replace a provider credential.
 *
 * Always writes to the canonical secret name only — never an alias, and
 * never a client-supplied name — so there is exactly one
 * administratively-writable location per provider going forward. Delegates
 * entirely to the existing Secrets Manager (`upsertSecret`): AES-256-GCM
 * encryption, HMAC sealing, and the audit log write all happen there,
 * unchanged. Returns only the masked preview + safe metadata the existing
 * service already returns — never the submitted value.
 */
async function saveProviderCredential(provider, value, adminUid) {
  const { canonicalName } = assertSupportedProvider(provider);
  const result = await upsertSecret(canonicalName, value, adminUid);

  return {
    provider,
    secretName: result.name,
    preview: result.preview,
    updatedAt: result.updatedAt,
  };
}

/**
 * Delete a provider's canonical credential. Aliases are never touched by
 * this gateway (it only ever wrote to the canonical name in the first
 * place), matching the "one provider cannot reach another secret" and
 * "no arbitrary secret name" constraints.
 */
async function deleteProviderCredential(provider, adminUid) {
  const { canonicalName } = assertSupportedProvider(provider);
  await deleteSecret(canonicalName, adminUid);
  return { provider, secretName: canonicalName };
}

module.exports = Object.freeze({
  PROVIDERS,
  isSupportedProvider,
  listProviderIds,
  getProviderStatus,
  listProviderStatuses,
  saveProviderCredential,
  deleteProviderCredential,
});
