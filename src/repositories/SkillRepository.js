'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const logger = require('../utils/logger');

class SkillRepository {
  constructor() {
    this._skillsPath = path.resolve(
      __dirname,
      '../data/career-graph/skills.json'
    );

    this._cache = null;
    this._lookup = null;
    this._loadPromise = null;
  }

  async _loadSkills() {
    if (this._cache) return this._cache;
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = this.#loadAndIndex();
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
    let raw;

    try {
      raw = await fs.readFile(this._skillsPath, 'utf8');
    } catch (error) {
      logger.error('[SkillRepository] Failed reading skills file', {
        path: this._skillsPath,
        message: error.message,
      });
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid JSON in skills.json: ${error.message}`
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error('skills.json must be an array');
    }

    const cache = [];
    const lookup = new Map();

    for (const skill of parsed) {
      if (!skill || typeof skill.name !== 'string') {
        continue;
      }

      const normalized = Object.freeze({
        name: skill.name.trim(),
        aliases: Object.freeze(
          Array.isArray(skill.aliases)
            ? skill.aliases.map(a => String(a).trim())
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