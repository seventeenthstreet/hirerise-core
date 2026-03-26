'use strict';

const fs = require('fs');
const path = require('path');

class SkillRepository {
  constructor() {
    this._skillsPath = path.join(
      __dirname,
      '../data/career-graph/skills.json'
    );

    this._cache = null;
  }

  /**
   * Safely loads and caches skills
   */
  _loadSkills() {
    if (this._cache) return this._cache;

    if (!fs.existsSync(this._skillsPath)) {
      throw new Error(`Skill file not found at ${this._skillsPath}`);
    }

    const raw = fs.readFileSync(this._skillsPath, 'utf8');

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in skills.json: ${err.message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('skills.json must be an array');
    }

    this._cache = parsed
      .filter(skill => skill && typeof skill.name === 'string')
      .map(skill => ({
        name: skill.name.trim(),
        aliases: Array.isArray(skill.aliases)
          ? skill.aliases.map(a => String(a).trim())
          : []
      }));

    return this._cache;
  }

  /**
   * Returns all skills with aliases
   */
  async getAllWithAliases() {
    return this._loadSkills();
  }

  /**
   * Returns single skill by name or alias
   */
  async getByName(name) {
    if (!name || typeof name !== 'string') return null;

    const skills = this._loadSkills();
    const lower = name.trim().toLowerCase();

    return (
      skills.find(
        s =>
          s.name.toLowerCase() === lower ||
          s.aliases.some(a => a.toLowerCase() === lower)
      ) || null
    );
  }

  /**
   * Clears cache (for admin refresh)
   */
  refreshCache() {
    this._cache = null;
  }
}

module.exports = SkillRepository;









