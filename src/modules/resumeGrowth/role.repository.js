'use strict';

const fs = require('fs');
const path = require('path');

class RoleRepository {
  constructor() {
    this._roles = new Map();
    this._loaded = false;
  }

  _loadRoles() {
    if (this._loaded) return;

    const baseDir = path.join(
      __dirname,
      '..',
      '..',
      'data',
      'career-graph'
    );

    const families = fs.readdirSync(baseDir, { withFileTypes: true });

    for (const family of families) {
      if (!family.isDirectory()) continue;

      const familyDir = path.join(baseDir, family.name);
      const files = fs.readdirSync(familyDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(familyDir, file);
        const role = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (role && role.role_id) {
          this._roles.set(role.role_id, role);
        }
      }
    }

    this._loaded = true;
    console.log(`[RoleRepository] Loaded ${this._roles.size} roles`);
  }

  async findById(roleId) {
    this._loadRoles();
    return this._roles.get(roleId) || null;
  }

  async getAll() {
    this._loadRoles();
    return Array.from(this._roles.values());
  }
}

module.exports = RoleRepository;