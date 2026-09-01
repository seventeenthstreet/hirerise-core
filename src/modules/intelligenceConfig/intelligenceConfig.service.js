'use strict';

/**
 * @file src/modules/intelligenceConfig/intelligenceConfig.service.js
 *
 * WP-ADMIN-INTEL-04 — domain service for ordinary, non-secret Intelligence
 * configuration administration.
 *
 * Every mutating operation here:
 *   - rejects unknown keys (via definitions.assertSupportedKey, the single
 *     choke point shared with the resolver and the DB CHECK constraint);
 *   - validates the submitted value against the definition's own
 *     `validate()` before it ever reaches the repository;
 *   - writes a safe, non-secret audit record via the existing generic
 *     admin audit logger (src/utils/adminAuditLogger.js) — the same
 *     `admin_logs` table WP-ADMIN-INTEL-03 and every other admin module
 *     already writes to. No new audit path is introduced.
 *   - invalidates the resolver's in-process cache immediately, so the
 *     writing request's own next resolution (and any other read in the
 *     same process) sees the change without waiting for the cache TTL.
 */

const { logAdminAction } = require('../../utils/adminAuditLogger');
const definitions = require('./intelligenceConfig.definitions');
const repository = require('./intelligenceConfig.repository');
const resolver = require('./intelligenceConfig.resolver');

const AUDIT_ENTITY_TYPE = 'intelligence_config';

/**
 * List every supported setting with its definition metadata and current
 * effective value + precedence source. Never returns a secret — this
 * module only ever touches intelligence_config_overrides, which the
 * WP-ADMIN-INTEL-04 audit confirmed holds no secret-classified settings.
 *
 * @returns {Promise<object[]>}
 */
async function listSettings() {
  const keys = definitions.listKeys();
  return Promise.all(
    keys.map(async (key) => {
      const definition = definitions.getDefinition(key);
      const effective = await resolver.resolveEffective(key);
      return describeSetting(definition, effective);
    })
  );
}

/**
 * @param {string} key
 * @returns {Promise<object>}
 */
async function getSetting(key) {
  const definition = definitions.assertSupportedKey(key);
  const effective = await resolver.resolveEffective(key);
  return describeSetting(definition, effective);
}

/**
 * Set (create or replace) the administrative override for a setting.
 *
 * @param {string} key
 * @param {string} rawValue — as submitted by the admin, pre-validation
 * @param {string} adminId — authenticated Master Admin actor id
 * @returns {Promise<object>}
 */
async function updateSetting(key, rawValue, adminId) {
  const definition = definitions.assertSupportedKey(key);

  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    if (!definition.emptyAllowed) {
      throw Object.assign(
        new Error('value is required. Use the reset endpoint to clear an override.'),
        { status: 400, code: 'INVALID_INPUT' }
      );
    }
  }

  const result = definition.validate(rawValue);
  if (!result.valid) {
    throw Object.assign(new Error(result.error), {
      status: 400,
      code: 'INVALID_CONFIG_VALUE',
    });
  }

  const previous = await repository.findByKey(key);
  const saved = await repository.upsert(key, result.normalized, adminId);

  // Write-through: this process resolves the new value immediately.
  resolver.invalidate(key, result.normalized);

  await logAdminAction({
    adminId,
    action: 'INTELLIGENCE_CONFIG_UPDATE',
    entityType: AUDIT_ENTITY_TYPE,
    entityId: key,
    metadata: {
      key,
      previousValue: previous ? previous.value : null,
      newValue: result.normalized,
    },
  });

  const effective = { value: saved.value, source: 'admin' };
  return describeSetting(definition, effective);
}

/**
 * Reset a setting: delete its administrative override so resolution falls
 * back to the environment/code-default tiers. No-op (but still audited)
 * when no override was set.
 *
 * @param {string} key
 * @param {string} adminId
 * @returns {Promise<object>}
 */
async function resetSetting(key, adminId) {
  const definition = definitions.assertSupportedKey(key);

  const previous = await repository.findByKey(key);
  const deleted = await repository.deleteByKey(key);

  // Drop rather than write-through: the next read must re-derive from the
  // environment/default tiers, not from a value we no longer trust.
  resolver.invalidate(key);

  await logAdminAction({
    adminId,
    action: 'INTELLIGENCE_CONFIG_RESET',
    entityType: AUDIT_ENTITY_TYPE,
    entityId: key,
    metadata: {
      key,
      previousValue: previous ? previous.value : null,
      wasSet: deleted,
    },
  });

  const effective = await resolver.resolveEffective(key);
  return describeSetting(definition, effective);
}

// ─────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────

function describeSetting(definition, effective) {
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    type: definition.type,
    allowedValues: definition.allowedValues,
    envVar: definition.envVar,
    codeDefault: definition.codeDefault,
    value: effective.value,
    source: effective.source, // 'admin' | 'environment' | 'default'
    adminConfigured: effective.source === 'admin',
  };
}

module.exports = {
  listSettings,
  getSetting,
  updateSetting,
  resetSetting,
};
