'use strict';

/**
 * roleAlias.repository.js — Supabase version
 */

const { supabase } = require('../../config/supabase');
const BaseRepository = require('../../repositories/BaseRepository');

const COLLECTION = 'role_aliases';

class RoleAliasRepository extends BaseRepository {
  constructor() {
    super(COLLECTION);
  }

  /**
   * Find canonical role by alias (case-insensitive).
   */
  async findCanonicalRole(alias) {
    if (!alias) return null;

    const normalized = alias.toLowerCase().trim();

    const { data, error } = await supabase
      .from(COLLECTION)
      .select('roleId, canonicalName')
      .eq('normalizedAlias', normalized)   // ⚠️ snake_case → normalized_alias
      .eq('softDeleted', false)            // ⚠️ → soft_deleted
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) return null;

    return {
      roleId: data.roleId,
      canonicalName: data.canonicalName,
    };
  }

  /**
   * Create alias (keeps BaseRepository logic)
   */
  async createAlias(payload, adminId) {
    return await super.create({
      alias: payload.alias.trim(),
      normalizedAlias: payload.alias.toLowerCase().trim(),
      canonicalName: payload.canonicalName,
      roleId: payload.roleId,
    }, adminId);
  }

  /**
   * List aliases by roleId
   */
  async findByRoleId(roleId) {
    const { data, error } = await supabase
      .from(COLLECTION)
      .select('*')
      .eq('roleId', roleId)        // ⚠️ → role_id
      .eq('softDeleted', false);   // ⚠️ → soft_deleted

    if (error) throw error;

    return (data || []).map(row => ({
      id: row.id,
      ...row
    }));
  }
}

module.exports = new RoleAliasRepository();
