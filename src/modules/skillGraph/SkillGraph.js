'use strict';

const logger = require('../../utils/logger');
const skillGraphRepository = require('./skillGraph.repository');

const MAX_PREREQ_DEPTH = 8;

const norm = (s = '') =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

class SkillGraph {
  constructor(repository = skillGraphRepository) {
    this.repository = repository;

    this._skills = new Map();
    this._relationships = [];
    this._roleSkills = new Map();

    this._prereqsOf = new Map();
    this._advancedOf = new Map();
    this._relatedTo = new Map();

    this._loaded = false;
    this._loadingPromise = null;
    this._lastLoadedAt = 0;
    this._cacheTtlMs = 5 * 60 * 1000;
  }

  async load(force = false) {
    const now = Date.now();

    if (
      !force &&
      this._loaded &&
      now - this._lastLoadedAt < this._cacheTtlMs
    ) {
      return this;
    }

    if (this._loadingPromise) {
      return this._loadingPromise;
    }

    this._loadingPromise = this._hydrate(force);

    try {
      await this._loadingPromise;
      return this;
    } finally {
      this._loadingPromise = null;
    }
  }

  async _hydrate() {
    const [skills, relationships, roleSkills] = await Promise.all([
      this.repository.getSkills(),
      this.repository.getRelationships(),
      this.repository.getRoleSkills(),
    ]);

    this._skills.clear();
    this._relationships = [];
    this._roleSkills.clear();
    this._prereqsOf.clear();
    this._advancedOf.clear();
    this._relatedTo.clear();

    for (const skill of skills) {
      this._skills.set(skill.skill_id, {
        skill_id: skill.skill_id,
        skill_name: skill.skill_name,
        skill_category: skill.skill_category || 'technical',
        difficulty_level: skill.difficulty_level || 1,
        demand_score: skill.demand_score || 5,
      });
    }

    this._relationships = relationships || [];

    for (const rel of this._relationships) {
      const { skill_id, related_skill_id, relationship_type } = rel;

      if (relationship_type === 'prerequisite') {
        if (!this._prereqsOf.has(related_skill_id)) {
          this._prereqsOf.set(related_skill_id, []);
        }
        this._prereqsOf.get(related_skill_id).push(rel);
      } else if (relationship_type === 'advanced') {
        if (!this._advancedOf.has(skill_id)) {
          this._advancedOf.set(skill_id, []);
        }
        this._advancedOf.get(skill_id).push(rel);
      } else {
        if (!this._relatedTo.has(skill_id)) {
          this._relatedTo.set(skill_id, []);
        }
        this._relatedTo.get(skill_id).push(rel);
      }
    }

    for (const row of roleSkills) {
      if (!this._roleSkills.has(row.role_id)) {
        this._roleSkills.set(row.role_id, {
          required: [],
          preferred: [],
        });
      }

      const bucket = this._roleSkills.get(row.role_id);

      const target =
        row.skill_type === 'preferred'
          ? bucket.preferred
          : bucket.required;

      target.push({
        skill_id: row.skill_id,
        importance_weight: row.importance_weight || 1,
      });
    }

    this._loaded = true;
    this._lastLoadedAt = Date.now();

    logger.info('SkillGraph hydrated from Supabase', {
      skills: this._skills.size,
      relationships: this._relationships.length,
      roles: this._roleSkills.size,
    });
  }

  async ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async getSkill(skillId) {
    await this.ensureLoaded();
    return skillId ? this._skills.get(skillId) || null : null;
  }

  async allSkills() {
    await this.ensureLoaded();
    return Array.from(this._skills.values());
  }

  async getSkillsByCategory(category) {
    await this.ensureLoaded();
    if (!category) return this.allSkills();

    return Array.from(this._skills.values()).filter(
      s => s.skill_category === category
    );
  }

  async searchSkills(query, { limit = 20, category = null } = {}) {
    await this.ensureLoaded();

    if (!query) {
      return Array.from(this._skills.values()).slice(0, limit);
    }

    const q = norm(query);
    const scored = [];

    for (const skill of this._skills.values()) {
      if (category && skill.skill_category !== category) continue;

      const name = norm(skill.skill_name);
      const id = norm(skill.skill_id.replace(/_/g, ' '));

      let score = 0;

      if (name === q || id === q) score = 100;
      else if (name.startsWith(q) || id.startsWith(q)) score = 70;
      else if (name.includes(q) || id.includes(q)) score = 40;
      else if (q.includes(name) && name.length > 3) score = 25;

      if (score > 0) scored.push({ skill, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.skill);
  }

  async getRelationships(skillId, type = null) {
    await this.ensureLoaded();

    return this._relationships
      .filter(
        r =>
          r.skill_id === skillId &&
          (!type || r.relationship_type === type)
      )
      .map(r => ({
        ...r,
        related_skill: this._skills.get(r.related_skill_id) || null,
      }))
      .sort((a, b) => (b.strength_score || 0) - (a.strength_score || 0));
  }

  async getPrerequisites(skillId, deep = true) {
    await this.ensureLoaded();

    if (!deep) {
      return (this._prereqsOf.get(skillId) || [])
        .map(r => this._skills.get(r.skill_id))
        .filter(Boolean);
    }

    const visited = new Set();
    const result = [];

    const traverse = (id, depth = 0) => {
      if (visited.has(id) || depth > MAX_PREREQ_DEPTH) return;
      visited.add(id);

      const prereqs = this._prereqsOf.get(id) || [];

      for (const rel of prereqs) {
        traverse(rel.skill_id, depth + 1);
      }

      if (id !== skillId) {
        const skill = this._skills.get(id);
        if (skill) result.push({ ...skill, depth });
      }
    };

    traverse(skillId);

    const seen = new Set();
    return result.filter(s => {
      if (seen.has(s.skill_id)) return false;
      seen.add(s.skill_id);
      return true;
    });
  }

  async getAdvancedSkills(skillId) {
    await this.ensureLoaded();

    return (this._advancedOf.get(skillId) || [])
      .map(r => this._skills.get(r.related_skill_id))
      .filter(Boolean);
  }

  async getRelatedSkills(skillId) {
    await this.ensureLoaded();

    return (this._relatedTo.get(skillId) || [])
      .map(r => ({
        ...this._skills.get(r.related_skill_id),
        relationship_type: r.relationship_type,
        strength_score: r.strength_score,
      }))
      .filter(Boolean);
  }

  async getRoleSkillMap(roleId) {
    await this.ensureLoaded();

    const map = this._roleSkills.get(roleId);

    if (!map) {
      return { role_id: roleId, required: [], preferred: [], all: [] };
    }

    const enrich = entries =>
      entries.map(e => ({
        ...e,
        skill: this._skills.get(e.skill_id) || { skill_id: e.skill_id },
      }));

    const required = enrich(map.required);
    const preferred = enrich(map.preferred);

    return {
      role_id: roleId,
      required,
      preferred,
      all: [...required, ...preferred],
    };
  }

  _normaliseUserSkills(userSkills = []) {
    const set = new Set();

    for (const s of userSkills) {
      const raw =
        typeof s === 'string'
          ? s
          : s?.name || s?.skill_id || s?.skill_name || '';

      if (!raw) continue;

      const normalized = norm(raw);
      const slug = raw
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');

      set.add(normalized);
      set.add(slug);
    }

    return set;
  }

  _userHasSkill(skillId, skillName, userSet) {
    if (!skillId && !skillName) return false;
    if (skillId && userSet.has(skillId)) return true;
    if (skillName && userSet.has(norm(skillName))) return true;
    return false;
  }
}

module.exports = new SkillGraph();
module.exports.SkillGraph = SkillGraph;