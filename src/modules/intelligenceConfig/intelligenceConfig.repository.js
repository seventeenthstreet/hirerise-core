'use strict';

/**
 * @file src/modules/intelligenceConfig/intelligenceConfig.repository.js
 *
 * WP-ADMIN-INTEL-04 — data access for admin-set Intelligence configuration
 * overrides. Talks only to `public.intelligence_config_overrides`
 * (migration 20260822050000_wp_admin_intel_04_config_overrides.sql).
 *
 * Mirrors the existing plain-class, direct-Supabase-client,
 * `_handleError`-wrapping pattern already used by
 * modules/admin/weights/adminWeights.repository.js and
 * modules/admin/cms/roles/adminCmsRoles.repository.js — not a new
 * repository architecture.
 *
 * This repository never validates `key` against the definitions registry
 * itself (that happens one layer up, in intelligenceConfig.service.js,
 * before this repository is ever called) — but the database's own
 * `intelligence_config_overrides_key_allowlist` CHECK constraint is a
 * second, independent backstop against an arbitrary key ever being
 * persisted.
 */

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { supabase } = require('../../config/supabase');

const TABLE = 'intelligence_config_overrides';
const COLUMNS = 'id, key, value, updated_by, updated_at, created_at';

class IntelligenceConfigRepository {
  /**
   * @param {string} key
   * @returns {Promise<object|null>} the override row, or null if no admin
   *   override is currently set for this key.
   */
  async findByKey(key) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(COLUMNS)
      .eq('key', key)
      .maybeSingle();

    if (error) throw this._handleError(error, 'findByKey');
    return this._toCamel(data);
  }

  /**
   * List every currently-set admin override. Used to build the
   * list/definitions response without N+1 lookups.
   *
   * @returns {Promise<object[]>}
   */
  async findAll() {
    const { data, error } = await supabase.from(TABLE).select(COLUMNS);
    if (error) throw this._handleError(error, 'findAll');
    return (data || []).map((row) => this._toCamel(row));
  }

  /**
   * Create or replace the admin override for a key. Upsert on the unique
   * `key` column — always ends with exactly one row per key, matching the
   * "one admin-controlled value per setting" contract (no history table;
   * old values reach the audit log via the caller, not via a DB row).
   *
   * @param {string} key
   * @param {string} value  — already validated/normalized by the caller
   * @param {string} updatedBy — authenticated admin actor id
   * @returns {Promise<object>}
   */
  async upsert(key, value, updatedBy) {
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(
        {
          key,
          value,
          updated_by: updatedBy,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key' }
      )
      .select(COLUMNS)
      .single();

    if (error) throw this._handleError(error, 'upsert');
    return this._toCamel(data);
  }

  /**
   * Delete the admin override for a key (reset to environment/code-default
   * precedence). Safe to call when no override exists — returns null
   * rather than erroring, matching the "reset when nothing is set" no-op
   * contract the service layer expects.
   *
   * @param {string} key
   * @returns {Promise<boolean>} true if a row was deleted, false if none existed
   */
  async deleteByKey(key) {
    const { data, error } = await supabase
      .from(TABLE)
      .delete()
      .eq('key', key)
      .select(COLUMNS);

    if (error) throw this._handleError(error, 'deleteByKey');
    return Array.isArray(data) && data.length > 0;
  }

  _handleError(error, operation) {
    return new AppError(
      error?.message || 'Intelligence configuration override query failed',
      500,
      { operation, details: error?.details ?? null },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  _toCamel(row) {
    if (!row) return null;
    return {
      id: row.id,
      key: row.key,
      value: row.value,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    };
  }
}

module.exports = new IntelligenceConfigRepository();
module.exports.IntelligenceConfigRepository = IntelligenceConfigRepository;
