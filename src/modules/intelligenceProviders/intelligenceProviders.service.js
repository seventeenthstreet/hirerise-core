'use strict';

/**
 * @file src/modules/intelligenceProviders/intelligenceProviders.service.js
 *
 * WP-ADMIN-INTEL-06 — domain service for the Intelligence Administration
 * "Add Provider" flow.
 *
 * Responsibilities:
 *   - Merge the five built-in, code/env-managed providers (status sourced
 *     from the existing intelligenceSecrets.config.js gateway, UNCHANGED)
 *     with admin-registered custom providers (this module's own registry
 *     table) into one list, so the UI can render a single table.
 *   - For every provider, report `runtimeSupported` honestly: true only
 *     when `provider_key` is a key in `aiProviderManager.PROVIDER_REGISTRY`
 *     (a real adapter module shipped in code). This is always true for the
 *     five built-ins and, today, always false for a custom provider —
 *     registering a row here does not fabricate execution capability.
 *   - Validate, create, update, and remove custom provider rows, writing a
 *     safe non-secret audit record for every mutation via the existing
 *     generic admin audit logger (src/utils/adminAuditLogger.js) — the
 *     same `admin_logs` table every other admin module already writes to.
 *     The credential value is NEVER included in audit metadata.
 *   - Orchestrate the write-only credential flow for custom providers via
 *     intelligenceProviders.secrets.js, mirroring the existing built-in
 *     provider credential flow (intelligenceSecrets.service.js) exactly —
 *     same "backend validates → Secrets Manager stores → only masked
 *     preview / status ever returned" contract.
 */

const { logAdminAction } = require('../../utils/adminAuditLogger');
const { PROVIDER_REGISTRY: RUNTIME_ADAPTERS } = require('../../services/ai/aiProviderManager');
const definitions = require('./intelligenceProviders.definitions');
const repository = require('./intelligenceProviders.repository');
const credentialGateway = require('./intelligenceProviders.secrets');
const builtinGateway = require('../intelligenceSecrets/intelligenceSecrets.config');

const AUDIT_ENTITY_TYPE = 'intelligence_provider';

function isRuntimeSupported(providerKey) {
  return Object.prototype.hasOwnProperty.call(RUNTIME_ADAPTERS, providerKey);
}

function runtimeStatusLabel({ runtimeSupported, credentialConfigured }) {
  if (!credentialConfigured) return 'not_configured';
  if (!runtimeSupported) return 'adapter_unavailable';
  return 'operational';
}

async function describeBuiltinProvider(providerKey) {
  const status = await builtinGateway.getProviderStatus(providerKey);
  return {
    providerKey,
    displayName: BUILTIN_LABELS[providerKey] || providerKey,
    adapterType: providerKey,
    apiEndpoint: null,
    defaultModel: null,
    credentialType: 'api_key',
    enabled: true,
    priorityPosition: null,
    metadata: {},
    builtIn: true,
    runtimeSupported: true,
    credentialConfigured: status.configured,
    credentialSource: status.secretsManagerConfigured
      ? 'secretsManager'
      : status.environmentConfigured
      ? 'environment'
      : null,
    runtimeStatus: runtimeStatusLabel({ runtimeSupported: true, credentialConfigured: status.configured }),
    createdAt: null,
    updatedAt: null,
  };
}

const BUILTIN_LABELS = Object.freeze({
  gemini: 'Google Gemini',
  grok: 'xAI Grok',
  mistral: 'Mistral',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
});

async function describeCustomProvider(row) {
  const credStatus = await credentialGateway.getCredentialStatus(row.providerKey);
  const runtimeSupported = isRuntimeSupported(row.providerKey);
  return {
    providerKey: row.providerKey,
    displayName: row.displayName,
    adapterType: row.adapterType,
    apiEndpoint: row.apiEndpoint,
    defaultModel: row.defaultModel,
    credentialType: row.credentialType,
    enabled: row.enabled,
    priorityPosition: row.priorityPosition,
    metadata: row.metadata,
    builtIn: false,
    runtimeSupported,
    credentialConfigured: credStatus.configured,
    credentialSource: credStatus.configured ? 'secretsManager' : null,
    runtimeStatus: runtimeStatusLabel({ runtimeSupported, credentialConfigured: credStatus.configured }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * List every provider — built-in (fixed 5) followed by admin-registered
 * custom providers — with merged, honest status.
 */
async function listProviders() {
  const [builtins, customRows] = await Promise.all([
    Promise.all(definitions.BUILTIN_PROVIDER_KEYS.map(describeBuiltinProvider)),
    repository.findAll(),
  ]);
  const customs = await Promise.all(customRows.map(describeCustomProvider));
  return { providers: [...builtins, ...customs] };
}

async function getProvider(providerKey) {
  if (definitions.BUILTIN_PROVIDER_KEYS.includes(providerKey)) {
    return describeBuiltinProvider(providerKey);
  }
  const row = await repository.findByKey(providerKey);
  if (!row) {
    throw Object.assign(new Error(`Provider '${providerKey}' not found.`), { status: 404, code: 'NOT_FOUND' });
  }
  return describeCustomProvider(row);
}

/**
 * Register a new custom provider. `credentialValue` is optional — the
 * ticket's flow allows registering configuration and configuring the
 * credential in the same submission (one dialog), but a provider may also
 * be registered first and have its credential configured afterward via
 * `setCredential`.
 */
async function addProvider(input, credentialValue, adminId) {
  const { valid, errors, normalized } = definitions.validateProviderInput(input, { partial: false });
  if (!valid) {
    throw Object.assign(new Error('Invalid provider configuration.'), {
      status: 400,
      code: 'INVALID_INPUT',
      details: errors,
    });
  }

  const existing = await repository.findByKey(normalized.providerKey);
  if (existing) {
    throw Object.assign(
      new Error(`A provider with key '${normalized.providerKey}' already exists.`),
      { status: 409, code: 'DUPLICATE_PROVIDER_KEY' }
    );
  }

  const row = await repository.create(
    {
      providerKey: normalized.providerKey,
      displayName: normalized.displayName,
      adapterType: normalized.adapterType,
      apiEndpoint: normalized.apiEndpoint ?? null,
      defaultModel: normalized.defaultModel ?? null,
      credentialType: normalized.credentialType ?? 'api_key',
      enabled: normalized.enabled ?? true,
      // Appended to the lowest priority position automatically — the
      // simplest behavior consistent with this table having no reordering
      // UI of its own yet (custom providers are not runtime-executable, so
      // they never enter the actual AI_PROVIDER_PRIORITY chain today; this
      // is a display-order placeholder for when a future adapter lands).
      priorityPosition: await nextPriorityPosition(),
      metadata: {},
    },
    adminId
  );

  let credentialResult = null;
  if (typeof credentialValue === 'string' && credentialValue.trim().length > 0) {
    credentialResult = await credentialGateway.saveCredential(row.providerKey, credentialValue, adminId);
  }

  await logAdminAction({
    adminId,
    action: 'INTELLIGENCE_PROVIDER_CREATE',
    entityType: AUDIT_ENTITY_TYPE,
    entityId: row.providerKey,
    metadata: {
      providerKey: row.providerKey,
      displayName: row.displayName,
      adapterType: row.adapterType,
      apiEndpoint: row.apiEndpoint,
      defaultModel: row.defaultModel,
      credentialType: row.credentialType,
      enabled: row.enabled,
      credentialConfiguredAtCreate: !!credentialResult,
      runtimeSupported: isRuntimeSupported(row.providerKey),
    },
  });

  return describeCustomProvider(row);
}

async function nextPriorityPosition() {
  const rows = await repository.findAll();
  const max = rows.reduce((acc, r) => (typeof r.priorityPosition === 'number' ? Math.max(acc, r.priorityPosition) : acc), -1);
  return max + 1;
}

/**
 * Update non-secret configuration for an existing custom provider.
 * Credential updates go exclusively through `setCredential`.
 */
async function updateProvider(providerKey, patch, adminId) {
  assertCustomProviderKey(providerKey);

  const existing = await repository.findByKey(providerKey);
  if (!existing) {
    throw Object.assign(new Error(`Provider '${providerKey}' not found.`), { status: 404, code: 'NOT_FOUND' });
  }

  const { valid, errors, normalized } = definitions.validateProviderInput(patch, { partial: true });
  if (!valid) {
    throw Object.assign(new Error('Invalid provider configuration.'), {
      status: 400,
      code: 'INVALID_INPUT',
      details: errors,
    });
  }
  // providerKey itself is never mutable via this endpoint — identity is
  // fixed at creation (it is also the credential's secret-name anchor).
  delete normalized.providerKey;

  const updated = await repository.update(providerKey, normalized, adminId);

  await logAdminAction({
    adminId,
    action: 'INTELLIGENCE_PROVIDER_UPDATE',
    entityType: AUDIT_ENTITY_TYPE,
    entityId: providerKey,
    metadata: {
      providerKey,
      changes: normalized,
    },
  });

  return describeCustomProvider(updated);
}

/**
 * Set/replace a custom provider's credential. Mirrors
 * intelligenceSecrets.service.js's saveProvider() exactly.
 */
async function setCredential(providerKey, value, adminId) {
  assertCustomProviderKey(providerKey);

  const existing = await repository.findByKey(providerKey);
  if (!existing) {
    throw Object.assign(new Error(`Provider '${providerKey}' not found.`), { status: 404, code: 'NOT_FOUND' });
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error('value is required.'), { status: 400, code: 'INVALID_INPUT' });
  }

  const result = await credentialGateway.saveCredential(providerKey, value, adminId);

  await logAdminAction({
    adminId,
    action: 'INTELLIGENCE_PROVIDER_CREDENTIAL_UPDATE',
    entityType: AUDIT_ENTITY_TYPE,
    entityId: providerKey,
    metadata: { providerKey },
  });

  return result;
}

/**
 * Remove a custom provider entirely: deletes its stored credential (if
 * any) and its registry row. Hard delete — unlike the built-in providers'
 * credential-only DELETE (which removes a secret but the provider
 * identity itself is permanent, code-defined), a custom provider's
 * *identity* only exists because an admin created it, so removing it here
 * removes the row. The full history of the action (who, when, what it was
 * configured as) still survives independently in the append-only
 * admin_logs audit trail, matching the "preserve audit history" ticket
 * requirement without needing a soft-delete flag on this table.
 *
 * A custom provider can never be referenced by the live AI_PROVIDER_PRIORITY
 * chain (see isRuntimeSupported — a custom key is never in
 * aiProviderManager.PROVIDER_REGISTRY, so intelligenceConfig's own
 * validateProviderPriority() already rejects it), so there is no runtime
 * configuration state to reconcile on removal.
 */
async function removeProvider(providerKey, adminId) {
  assertCustomProviderKey(providerKey);

  const existing = await repository.findByKey(providerKey);
  if (!existing) {
    throw Object.assign(new Error(`Provider '${providerKey}' not found.`), { status: 404, code: 'NOT_FOUND' });
  }

  // Best-effort credential cleanup — proceed with removing the registry
  // row regardless (mirrors deleteSecret's own "safe to call when nothing
  // is stored" semantics; a lookup miss here is not an error).
  try {
    await credentialGateway.deleteCredential(providerKey, adminId);
  } catch (err) {
    if (err?.status !== 404) throw err;
  }

  await repository.deleteByKey(providerKey);

  await logAdminAction({
    adminId,
    action: 'INTELLIGENCE_PROVIDER_DELETE',
    entityType: AUDIT_ENTITY_TYPE,
    entityId: providerKey,
    metadata: {
      providerKey,
      displayName: existing.displayName,
      adapterType: existing.adapterType,
    },
  });

  return { providerKey };
}

function assertCustomProviderKey(providerKey) {
  if (definitions.BUILTIN_PROVIDER_KEYS.includes(providerKey)) {
    throw Object.assign(
      new Error(`'${providerKey}' is a built-in provider and is managed via the credentials section above.`),
      { status: 400, code: 'BUILTIN_PROVIDER_KEY' }
    );
  }
}

module.exports = {
  listProviders,
  getProvider,
  addProvider,
  updateProvider,
  setCredential,
  removeProvider,
  isRuntimeSupported,
};
