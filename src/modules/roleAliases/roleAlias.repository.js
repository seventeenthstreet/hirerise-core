'use strict';

/**
 * src/modules/roleAliases/roleAlias.repository.js
 *
 * Supabase-native repository for role_aliases
 *
 * Fully removes BaseRepository / Firebase legacy inheritance.
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');

const TABLE = 'role_aliases';

class RoleAliasRepository {
  static get SELECT_COLUMNS() {
    return `
      id,
      alias,
      normalizedAlias,
      canonicalName,
      roleId,
      softDeleted,
      createdAt,
      updatedAt
    `;
  }

  /**
   * Normalize DB row into safe domain object.
   * @param {object} row
   * @returns {object|null}
   */
  normalize(row) {
    if (!row) return null;

    return {
      id: row.id,
      alias: row.alias ?? null,
      normalizedAlias: row.normalizedAlias ?? null,
      canonicalName: row.canonicalName ?? null,
      roleId: row.roleId ?? null,
      softDeleted: Boolean(row.softDeleted),
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null
    };
  }

  /**
   * Find canonical role by alias (case-insensitive)
   * Preserves existing business behavior.
   *
   * @param {string} alias
   * @returns {Promise<object|null>}
   */
  async findCanonicalRole(alias) {
    if (!alias || typeof alias !== 'string') return null;

    const normalized = alias.trim().toLowerCase();
    if (!normalized) return null;

    const { data, error } = await supabase
      .from(TABLE)
      .select('roleId, canonicalName')
      .eq('normalizedAlias', normalized)
      .eq('softDeleted', false)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new AppError(
        'Failed to resolve canonical role alias',
        500,
        ErrorCodes.DB_ERROR,
        error
      );
    }

    if (!data) return null;

    return {
      roleId: data.roleId ?? null,
      canonicalName: data.canonicalName ?? null
    };
  }

  /**
   * Create new alias.
   * Replaces BaseRepository.create()
   *
   * @param {object} payload
   * @param {string} adminId
   * @returns {Promise<object>}
   */
  async createAlias(payload, adminId) {
    if (!payload?.alias || !payload?.canonicalName || !payload?.roleId) {
      throw new AppError(
        'alias, canonicalName and roleId are required',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const timestamp = new Date().toISOString();

    const insertPayload = {
      alias: payload.alias.trim(),
      normalizedAlias: payload.alias.trim().toLowerCase(),
      canonicalName: payload.canonicalName,
      roleId: payload.roleId,
      softDeleted: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: adminId || null,
      updatedBy: adminId || null
    };

    const { data, error } = await supabase
      .from(TABLE)
      .insert(insertPayload)
      .select(RoleAliasRepository.SELECT_COLUMNS)
      .single();

    if (error) {
      throw new AppError(
        'Failed to create role alias',
        500,
        ErrorCodes.DB_ERROR,
        error
      );
    }

    return this.normalize(data);
  }

  /**
   * List aliases by roleId
   *
   * @param {string} roleId
   * @returns {Promise<object[]>}
   */
  async findByRoleId(roleId) {
    if (!roleId) {
      throw new AppError(
        'roleId is required',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const { data, error } = await supabase
      .from(TABLE)
      .select(RoleAliasRepository.SELECT_COLUMNS)
      .eq('roleId', roleId)
      .eq('softDeleted', false)
      .order('createdAt', { ascending: true });

    if (error) {
      throw new AppError(
        'Failed to fetch aliases by roleId',
        500,
        ErrorCodes.DB_ERROR,
        error
      );
    }

    return (data || []).map((row) => this.normalize(row));
  }
}

module.exports = new RoleAliasRepository();