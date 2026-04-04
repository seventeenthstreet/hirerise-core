'use strict';

/**
 * src/modules/resumeGrowth/role.repository.js
 *
 * Production-ready async cached role repository
 * --------------------------------------------
 * File-backed role taxonomy loader.
 *
 * Optimized for:
 * - zero sync filesystem blocking
 * - single hydration promise
 * - race-safe cache loading
 * - immutable snapshots
 * - clean async architecture
 */

const fs = require('fs/promises');
const path = require('path');

class RoleRepository {
  constructor() {
    this._roles = new Map();
    this._loadPromise = null;
    this._loaded = false;
  }

  async _loadRoles() {
    if (this._loaded) return;

    if (this._loadPromise) {
      await this._loadPromise;
      return;
    }

    this._loadPromise = this._hydrateRoles();

    try {
      await this._loadPromise;
      this._loaded = true;
    } finally {
      this._loadPromise = null;
    }
  }

  async _hydrateRoles() {
    const baseDir = path.join(
      __dirname,
      '..',
      '..',
      'data',
      'career-graph'
    );

    const families = await fs.readdir(baseDir, {
      withFileTypes: true,
    });

    const nextRoles = new Map();

    for (const family of families) {
      if (!family.isDirectory()) continue;

      const familyDir = path.join(baseDir, family.name);
      const files = await fs.readdir(familyDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(familyDir, file);
        const raw = await fs.readFile(filePath, 'utf8');

        let role = null;

        try {
          role = JSON.parse(raw);
        } catch {
          continue;
        }

        if (role?.role_id) {
          nextRoles.set(role.role_id, role);
        }
      }
    }

    this._roles = nextRoles;
  }

  async findById(roleId) {
    await this._loadRoles();
    return this._roles.get(roleId) || null;
  }

  async getAll() {
    await this._loadRoles();
    return Object.freeze([...this._roles.values()]);
  }

  async reload() {
    this._loaded = false;
    this._loadPromise = null;
    await this._loadRoles();
    return this._roles.size;
  }
}

module.exports = RoleRepository;