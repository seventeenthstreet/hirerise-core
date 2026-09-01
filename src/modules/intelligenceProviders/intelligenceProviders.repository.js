'use strict';

/**
 * @file src/modules/intelligenceProviders/intelligenceProviders.repository.js
 *
 * WP-ADMIN-INTEL-06 — data access for admin-registered AI provider
 * configuration. Talks only to `public.intelligence_provider_registry`
 * (migration 20260824120000_wp_admin_intel_06_provider_registry.sql).
 *
 * Mirrors intelligenceConfig.repository.js's plain-class,
 * direct-Supabase-client, `_handleError`-wrapping pattern — not a new
 * repository architecture. Never stores or reads a credential value; this
 * table only ever holds non-secret configuration (see the migration's doc
 * comment).
 */

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { supabase } = require('../../config/supabase');

const TABLE = 'intelligence_provider_registry';
const COLUMNS =
  'id, provider_key, display_name, adapter_type, api_endpoint, default_model, ' +
  'credential_type, enabled, priority_position, metadata, created_by, updated_by, ' +
  'created_at, updated_at';

class IntelligenceProviderRegistryRepository {
  async findAll() {
    const { data, error } = await supabase
      .from(TABLE)
      .select(COLUMNS)
      .order('created_at', { ascending: true });

    if (error) throw this._handleError(error, 'findAll');
    return (data || []).map((row) => this._toCamel(row));
  }

  async findByKey(providerKey) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(COLUMNS)
      .eq('provider_key', providerKey)
      .maybeSingle();

    if (error) throw this._handleError(error, 'findByKey');
    return this._toCamel(data);
  }

  async create(fields, actorId) {
    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        provider_key: fields.providerKey,
        display_name: fields.displayName,
        adapter_type: fields.adapterType,
        api_endpoint: fields.apiEndpoint ?? null,
        default_model: fields.defaultModel ?? null,
        credential_type: fields.credentialType ?? 'api_key',
        enabled: fields.enabled ?? true,
        priority_position: fields.priorityPosition ?? null,
        metadata: fields.metadata ?? {},
        created_by: actorId || null,
        updated_by: actorId || null,
      })
      .select(COLUMNS)
      .single();

    if (error) throw this._handleError(error, 'create');
    return this._toCamel(data);
  }

  /**
   * Partial update of non-secret fields only. `patch` must already be
   * normalized/validated by the caller (service layer) — this repository
   * writes exactly the keys given it, nothing more.
   */
  async update(providerKey, patch, actorId) {
    const row = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'displayName')) row.display_name = patch.displayName;
    if (Object.prototype.hasOwnProperty.call(patch, 'adapterType')) row.adapter_type = patch.adapterType;
    if (Object.prototype.hasOwnProperty.call(patch, 'apiEndpoint')) row.api_endpoint = patch.apiEndpoint;
    if (Object.prototype.hasOwnProperty.call(patch, 'defaultModel')) row.default_model = patch.defaultModel;
    if (Object.prototype.hasOwnProperty.call(patch, 'credentialType')) row.credential_type = patch.credentialType;
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) row.enabled = patch.enabled;
    if (Object.prototype.hasOwnProperty.call(patch, 'priorityPosition')) row.priority_position = patch.priorityPosition;
    if (Object.prototype.hasOwnProperty.call(patch, 'metadata')) row.metadata = patch.metadata;
    row.updated_by = actorId || null;
    row.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from(TABLE)
      .update(row)
      .eq('provider_key', providerKey)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw this._handleError(error, 'update');
    return this._toCamel(data);
  }

  async deleteByKey(providerKey) {
    const { data, error } = await supabase
      .from(TABLE)
      .delete()
      .eq('provider_key', providerKey)
      .select(COLUMNS);

    if (error) throw this._handleError(error, 'deleteByKey');
    return Array.isArray(data) && data.length > 0;
  }

  _handleError(error, operation) {
    // Surface duplicate-key as a safe 409 rather than a generic 500 — the
    // service layer already checks for an existing row first, but the
    // unique constraint is the authoritative backstop against a race.
    if (error?.code === '23505') {
      return new AppError('A provider with this key already exists.', 409, { operation }, ErrorCodes.CONFLICT || 'CONFLICT');
    }
    return new AppError(
      error?.message || 'Intelligence provider registry query failed',
      500,
      { operation, details: error?.details ?? null },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  _toCamel(row) {
    if (!row) return null;
    return {
      id: row.id,
      providerKey: row.provider_key,
      displayName: row.display_name,
      adapterType: row.adapter_type,
      apiEndpoint: row.api_endpoint,
      defaultModel: row.default_model,
      credentialType: row.credential_type,
      enabled: row.enabled,
      priorityPosition: row.priority_position,
      metadata: row.metadata || {},
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new IntelligenceProviderRegistryRepository();
module.exports.IntelligenceProviderRegistryRepository = IntelligenceProviderRegistryRepository;
