'use strict';

/**
 * roleAlias.repository.js — Role Name Normalization Data Access
 *
 * Collection: role_aliases
 *
 * Schema:
 *   {
 *     id,
 *     alias:         string  — the alternate/raw name (e.g. "Backend Developer")
 *     normalizedAlias: string — alias.toLowerCase().trim()
 *     canonicalName: string  — the standard role name (e.g. "Software Engineer")
 *     roleId:        string  — Firestore document ID in cms_roles
 *     createdAt, updatedAt
 *   }
 *
 * Purpose:
 *   Normalize role names from CSV imports, API responses, and scrapers
 *   to canonical roles that exist in the cms_roles collection.
 *
 * @module modules/roleAliases/roleAlias.repository
 */

const BaseRepository = require('../../repositories/BaseRepository');

const COLLECTION = 'role_aliases';

class RoleAliasRepository extends BaseRepository {
  constructor() {
    super(COLLECTION);
  }

  /**
   * Find canonical role by alias string (case-insensitive).
   *
   * @param {string} alias  — already lowercased and trimmed by caller
   * @returns {Promise<{ roleId: string, canonicalName: string }|null>}
   */
  async findCanonicalRole(alias) {
    if (!alias) return null;

    const col  = this._getCollection();
    const snap = await col
      .where('normalizedAlias', '==', alias.toLowerCase().trim())
      .where('softDeleted',     '==', false)
      .limit(1)
      .get();

    if (snap.empty) return null;
    const data = snap.docs[0].data();
    return {
      roleId:        data.roleId,
      canonicalName: data.canonicalName,
    };
  }

  /**
   * Create a role alias mapping.
   *
   * @param {{ alias: string, canonicalName: string, roleId: string }} payload
   * @param {string} adminId
   * @returns {Promise<object>}
   */
  async createAlias(payload, adminId) {
    return await super.create({
      alias:           payload.alias.trim(),
      normalizedAlias: payload.alias.toLowerCase().trim(),
      canonicalName:   payload.canonicalName,
      roleId:          payload.roleId,
    }, adminId);
  }

  /**
   * List all aliases for a given roleId.
   *
   * @param {string} roleId
   * @returns {Promise<object[]>}
   */
  async findByRoleId(roleId) {
    const col  = this._getCollection();
    const snap = await col
      .where('roleId',      '==', roleId)
      .where('softDeleted', '==', false)
      .get();

    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = new RoleAliasRepository();








