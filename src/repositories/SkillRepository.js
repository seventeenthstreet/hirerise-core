'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

class SkillRepository {
  constructor() {
    this._cache = null;
    this._lookup = null;
    this._loadPromise = null;
  }

  async _loadSkills() {
    if (this._cache) return this._cache;
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = this.#loadAndIndex()
      .catch((error) => {
        this._loadPromise = null;
        throw error;
      });

    return this._loadPromise;
  }

  async getAllWithAliases() {
    return this._loadSkills();
  }

  async getByName(name) {
    if (!name || typeof name !== 'string') {
      return null;
    }

    await this._loadSkills();

    return (
      this._lookup.get(name.trim().toLowerCase()) ??
      null
    );
  }

  refreshCache() {
    this._cache = null;
    this._lookup = null;
    this._loadPromise = null;
  }

  async #loadAndIndex() {
    const { data, error } = await supabase
      .from('skills')
      .select('name, aliases')
      .eq('soft_deleted', false)
      .order('name', { ascending: true });

    if (error) {
      logger.error(
        '[SkillRepository] Failed loading skills from Supabase',
        {
          message: error.message,
        }
      );
      throw error;
    }

    const cache = [];
    const lookup = new Map();

    for (const skill of data ?? []) {
      if (!skill || typeof skill.name !== 'string') {
        continue;
      }

      const normalized = Object.freeze({
        name: skill.name.trim(),
        aliases: Object.freeze(
          Array.isArray(skill.aliases)
            ? skill.aliases.map((a) =>
                String(a).trim()
              )
            : []
        ),
      });

      cache.push(normalized);

      lookup.set(
        normalized.name.toLowerCase(),
        normalized
      );

      for (const alias of normalized.aliases) {
        lookup.set(alias.toLowerCase(), normalized);
      }
    }

    this._cache = Object.freeze(cache);
    this._lookup = lookup;

    logger.info('[SkillRepository] Skills loaded', {
      totalSkills: cache.length,
      totalLookupKeys: lookup.size,
    });

    return this._cache;
  }
}

module.exports = SkillRepository;