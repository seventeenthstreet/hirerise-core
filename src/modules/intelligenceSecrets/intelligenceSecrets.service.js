'use strict';

/**
 * @file src/modules/intelligenceSecrets/intelligenceSecrets.service.js
 *
 * WP-ADMIN-INTEL-03 — Intelligence secret domain service.
 *
 * Thin orchestration layer between the HTTP controller and the
 * intelligenceSecrets.config gateway. Contains no direct Secrets Manager
 * calls of its own — all secret I/O is delegated to
 * `./intelligenceSecrets.config`, keeping exactly one module per domain
 * allowed to touch `secrets.service` (mirrors marketIntelligence.service.js
 * → marketIntelligence.config.js).
 */

const gateway = require('./intelligenceSecrets.config');

async function listProviders() {
  const providers = await gateway.listProviderStatuses();
  return { providers };
}

async function getProvider(provider) {
  return gateway.getProviderStatus(provider);
}

async function saveProvider(provider, value, adminUid) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(
      new Error('value is required.'),
      { status: 400, code: 'INVALID_INPUT' }
    );
  }

  return gateway.saveProviderCredential(provider, value, adminUid);
}

async function deleteProvider(provider, adminUid) {
  return gateway.deleteProviderCredential(provider, adminUid);
}

module.exports = {
  listProviders,
  getProvider,
  saveProvider,
  deleteProvider,
};
