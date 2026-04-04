'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const logger = require('../utils/logger');

const BASE_PATH = path.resolve(
  __dirname,
  '../data/career-graph'
);

class CareerGraphRepository {
  constructor() {
    this.roleCache = new Map();
    this.isLoaded = false;
    this.loadPromise = null;
  }

  async initialize() {
    if (this.isLoaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this.#loadAllRoles();
    await this.loadPromise;
    this.isLoaded = true;
  }

  async getRole(roleId) {
    await this.initialize();
    return this.roleCache.get(roleId) ?? null;
  }

  async getNextRoles(roleId) {
    const role = await this.getRole(roleId);

    if (!role || !Array.isArray(role.next_roles)) {
      return [];
    }

    return role.next_roles
      .map(id => this.roleCache.get(id))
      .filter(Boolean);
  }

  async #loadAllRoles() {
    logger.info('[CareerGraphRepository] Loading career graph', {
      basePath: BASE_PATH,
    });

    let families;

    try {
      families = await fs.readdir(BASE_PATH, {
        withFileTypes: true,
      });
    } catch (error) {
      logger.error('[CareerGraphRepository] Failed reading base path', {
        basePath: BASE_PATH,
        message: error.message,
      });
      throw error;
    }

    for (const family of families) {
      if (!family.isDirectory()) continue;

      const familyPath = path.join(BASE_PATH, family.name);

      let files = [];
      try {
        files = await fs.readdir(familyPath, {
          withFileTypes: true,
        });
      } catch (error) {
        logger.error('[CareerGraphRepository] Failed reading family', {
          family: family.name,
          message: error.message,
        });
        continue;
      }

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) {
          continue;
        }

        const filePath = path.join(familyPath, file.name);

        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const data = JSON.parse(raw);

          if (!data?.role_id) {
            logger.warn('[CareerGraphRepository] Missing role_id', {
              filePath,
            });
            continue;
          }

          if (this.roleCache.has(data.role_id)) {
            logger.warn('[CareerGraphRepository] Duplicate role_id', {
              roleId: data.role_id,
              filePath,
            });
          }

          this.roleCache.set(
            data.role_id,
            Object.freeze(data)
          );
        } catch (error) {
          logger.error('[CareerGraphRepository] Failed loading role', {
            filePath,
            message: error.message,
          });
        }
      }
    }

    logger.info('[CareerGraphRepository] Career graph loaded', {
      totalRoles: this.roleCache.size,
    });
  }
}

module.exports = new CareerGraphRepository();