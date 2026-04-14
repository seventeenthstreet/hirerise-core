'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

class CareerGraphRepository {
  constructor() {
    this.roleCache = new Map();
    this.isLoaded = false;
    this.loadPromise = null;
  }

  async initialize() {
    if (this.isLoaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this.#loadAllRoles()
      .then(() => {
        this.isLoaded = true;
      })
      .catch((error) => {
        this.loadPromise = null;
        this.isLoaded = false;
        throw error;
      });

    return this.loadPromise;
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
      .map((id) => this.roleCache.get(id))
      .filter(Boolean);
  }

  async refresh() {
    this.roleCache.clear();
    this.isLoaded = false;
    this.loadPromise = null;
    return this.initialize();
  }

  async #loadAllRoles() {
    logger.info(
      '[CareerGraphRepository] Loading career graph from Supabase'
    );

    const { data, error } = await supabase
      .from('career_graph_roles')
      .select('*')
      .eq('soft_deleted', false)
      .order('role_id', { ascending: true });

    if (error) {
      logger.error(
        '[CareerGraphRepository] Failed loading career graph',
        {
          message: error.message,
        }
      );
      throw error;
    }

    for (const row of data ?? []) {
      if (!row?.role_id) {
        logger.warn(
          '[CareerGraphRepository] Missing role_id in row'
        );
        continue;
      }

      if (this.roleCache.has(row.role_id)) {
        logger.warn(
          '[CareerGraphRepository] Duplicate role_id detected',
          {
            roleId: row.role_id,
          }
        );
      }

      this.roleCache.set(
        row.role_id,
        Object.freeze(row)
      );
    }

    logger.info('[CareerGraphRepository] Career graph loaded', {
      totalRoles: this.roleCache.size,
    });
  }
}

module.exports = new CareerGraphRepository();