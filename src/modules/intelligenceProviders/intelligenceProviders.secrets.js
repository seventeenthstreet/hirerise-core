'use strict';

/**
 * @file src/modules/intelligenceProviders/intelligenceProviders.secrets.js
 *
 * WP-ADMIN-INTEL-06 — credential gateway for admin-registered ("custom")
 * AI providers, i.e. anything created through the new "Add Provider" flow.
 *
 * This is the sibling of intelligenceSecrets.config.js for the five
 * built-in providers: same write-only model, same underlying Secrets
 * Manager (`../secrets/secrets.service` — AES-256-GCM + HMAC, unchanged),
 * same "never decrypt just to answer a status check" discipline. It is
 * kept as a separate, dedicated gateway rather than folding into
 * intelligenceSecrets.config.js because that module is explicitly
 * documented as deriving its provider identity from the fixed
 * `PROVIDER_ENV_KEYS` registry and refusing anything else — this module's
 * whole purpose is the opposite case: a provider identity that only
 * exists because an admin created it. Keeping the two gateways separate
 * means neither one gains the ability to reach the other's secret
 * namespace, and a custom provider can never collide with a built-in
 * provider's env-var-derived secret name.
 *
 * Canonical secret name derivation: `INTEL_PROVIDER_<PROVIDER_KEY>_API_KEY`
 * (upper-cased provider_key). provider_key is already constrained to
 * `^[a-z][a-z0-9_]{1,39}$` by intelligenceProviders.definitions.js /
 * the DB CHECK constraint, so the derived name always satisfies
 * secrets.service's own `NAME_REGEX` (`^[A-Z0-9_]{1,100}$`) — this
 * function still defensively re-validates rather than trusting that by
 * construction.
 */

const logger = require('../../utils/logger');
const {
  upsertSecret,
  getSecretStatus,
  deleteSecret,
} = require('../secrets/secrets.service');
const { PROVIDER_KEY_REGEX } = require('./intelligenceProviders.definitions');

function secretNameFor(providerKey) {
  if (typeof providerKey !== 'string' || !PROVIDER_KEY_REGEX.test(providerKey)) {
    throw Object.assign(new Error('Invalid provider key.'), { status: 400, code: 'INVALID_PROVIDER_KEY' });
  }
  return `INTEL_PROVIDER_${providerKey.toUpperCase()}_API_KEY`;
}

/**
 * Safe, non-plaintext credential status for a custom provider. Never
 * decrypts a value (uses getSecretStatus, not getSecret).
 */
async function getCredentialStatus(providerKey) {
  const secretName = secretNameFor(providerKey);
  try {
    await getSecretStatus(secretName);
    return { secretName, configured: true };
  } catch (err) {
    if (err?.status !== 404) {
      logger.warn('[IntelligenceProviderSecrets] Secret status lookup failed', {
        providerKey,
        error: err?.message,
      });
    }
    return { secretName, configured: false };
  }
}

/**
 * Store/replace a custom provider's credential. Delegates entirely to the
 * existing Secrets Manager (`upsertSecret`) — encryption, HMAC sealing,
 * and the audit log write all happen there, unchanged. Returns only the
 * masked preview + safe metadata the underlying service already returns —
 * never the submitted value.
 */
async function saveCredential(providerKey, value, adminUid) {
  const secretName = secretNameFor(providerKey);
  const result = await upsertSecret(secretName, value, adminUid);
  return {
    providerKey,
    secretName: result.name,
    preview: result.preview,
    updatedAt: result.updatedAt,
  };
}

/**
 * Delete a custom provider's stored credential. Safe to call when nothing
 * is stored yet — deleteSecret's own semantics apply unchanged.
 */
async function deleteCredential(providerKey, adminUid) {
  const secretName = secretNameFor(providerKey);
  await deleteSecret(secretName, adminUid);
  return { providerKey, secretName };
}

module.exports = {
  secretNameFor,
  getCredentialStatus,
  saveCredential,
  deleteCredential,
};
