'use strict';

/**
 * SkillGraph.js — Skill Graph Intelligence Engine
 *
 * Transforms HireRise skills from a flat list into a directed graph where
 * skills are connected to each other (via skill_relationships.json) and
 * to roles (via required_skills / preferred_skills in role nodes).
 *
 * Architecture:
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │  Data sources                                                     │
 *   │    skills_registry.json     — skill nodes (id, name, category,   │
 *   │                               difficulty_level, demand_score)    │
 *   │    skill_relationships.json — directed edges between skills       │
 *   │    {family}/*.json          — role nodes with required_skills[]  │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Public API:
 *   sg.getSkill(skillId)                         → SkillNode | null
 *   sg.searchSkills(query, opts?)                → SkillNode[]
 *   sg.getSkillsByCategory(category)             → SkillNode[]
 *   sg.getRelationships(skillId, type?)          → RelEdge[]
 *   sg.getPrerequisites(skillId, deep?)          → SkillNode[]  (transitive)
 *   sg.getAdvancedSkills(skillId)                → SkillNode[]
 *   sg.getRelatedSkills(skillId)                 → SkillNode[]
 *   sg.getRoleSkillMap(roleId)                   → RoleSkillMap
 *   sg.detectGap(userSkills, roleId)             → SkillGapResult
 *   sg.generateLearningPath(missingSkillId, userSkills) → LearningPath
 *   sg.generateLearningPaths(missingSkills, userSkills) → LearningPath[]
 *   sg.computeSkillScore(userSkills, roleId)     → SkillScore  (for CHI)
 *   sg.allSkills()                               → SkillNode[]
 */

const fs   = require('fs');
const path = require('path');

const GRAPH_DIR = path.join(__dirname, '../../data/career-graph');

// Normalise a string for fuzzy matching
const norm = (s = '') =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

class SkillGraph {
  constructor() {
    this._skills        = new Map();  // skill_id → SkillNode
    this._relationships = [];         // RelEdge[]
    this._roleSkills    = new Map();  // role_id → { required[], preferred[] }
    this._loaded        = false;

    // Adjacency maps built at load time for fast traversal
    this._prereqsOf  = new Map();  // skill_id → Set of prerequisite skill_ids
    this._advancedOf = new Map();  // skill_id → Set of advanced skill_ids
    this._relatedTo  = new Map();  // skill_id → Set of related/complementary ids
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ═══════════════════════════════════════════════════════════════════════════

  load() {
    if (this._loaded) return this;

    // 1. Skills registry
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(GRAPH_DIR, 'skills_registry.json'), 'utf8')
      );
      for (const skill of (raw.skills || [])) {
        this._skills.set(skill.skill_id, {
          skill_id:        skill.skill_id,
          skill_name:      skill.skill_name,
          skill_category:  skill.skill_category || 'technical',
          difficulty_level: skill.difficulty_level || 1,
          demand_score:    skill.demand_score || 5,
        });
      }
    } catch (e) {
      // No registry — degrade gracefully
    }

    // 2. Skill relationships
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(GRAPH_DIR, 'skill_relationships.json'), 'utf8')
      );
      this._relationships = raw.relationships || [];

      // Edge convention in skill_relationships.json:
      //   { skill_id: A, related_skill_id: B, relationship_type: "prerequisite" }
      //   means: A IS A PREREQUISITE OF B  (learn A before B)
      //
      // So to find "what must I learn before skill X":
      //   look for edges where related_skill_id === X AND type === 'prerequisite'
      //
      // _prereqsOf[targetSkill] = [{ skill_id: prerequisiteSkill, ... }]

      for (const rel of this._relationships) {
        const { skill_id, related_skill_id, relationship_type } = rel;

        if (relationship_type === 'prerequisite') {
          // skill_id is a prerequisite OF related_skill_id
          if (!this._prereqsOf.has(related_skill_id)) this._prereqsOf.set(related_skill_id, []);
          this._prereqsOf.get(related_skill_id).push(rel);
        } else if (relationship_type === 'advanced') {
          // skill_id advances TO related_skill_id
          if (!this._advancedOf.has(skill_id)) this._advancedOf.set(skill_id, []);
          this._advancedOf.get(skill_id).push(rel);
        } else {
          // related / complementary
          if (!this._relatedTo.has(skill_id)) this._relatedTo.set(skill_id, []);
          this._relatedTo.get(skill_id).push(rel);
        }
      }
    } catch (e) {
      this._relationships = [];
    }

    // 3. Role → skills mapping (from family JSON nodes)
    try {
      const families = fs.readdirSync(GRAPH_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const family of families) {
        const dir   = path.join(GRAPH_DIR, family);
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const node = JSON.parse(
              fs.readFileSync(path.join(dir, file), 'utf8')
            );
            if (node.role_id) {
              this._roleSkills.set(node.role_id, {
                required:  (node.required_skills  || []).map(id => ({
                  skill_id: id, importance_weight: 1.0,
                })),
                preferred: (node.preferred_skills || []).map(id => ({
                  skill_id: id, importance_weight: 0.5,
                })),
              });
            }
          } catch (_) {}
        }
      }
    } catch (e) {}

    this._loaded = true;
    return this;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SKILL LOOKUP
  // ═══════════════════════════════════════════════════════════════════════════

  getSkill(skillId) {
    if (!skillId) return null;
    return this._skills.get(skillId) || null;
  }

  allSkills() {
    return Array.from(this._skills.values());
  }

  getSkillsByCategory(category) {
    if (!category) return this.allSkills();
    return Array.from(this._skills.values())
      .filter(s => s.skill_category === category);
  }

  /**
   * Fuzzy search — matches skill_id slug and skill_name.
   * Returns skills ordered by relevance score.
   */
  searchSkills(query, { limit = 20, category = null } = {}) {
    if (!query) return this.allSkills().slice(0, limit);
    const q = norm(query);

    const scored = [];
    for (const skill of this._skills.values()) {
      if (category && skill.skill_category !== category) continue;

      const name = norm(skill.skill_name);
      const id   = norm(skill.skill_id.replace(/_/g, ' '));
      let score  = 0;

      if (name === q || id === q)                    score = 100;
      else if (name.startsWith(q) || id.startsWith(q)) score = 70;
      else if (name.includes(q)  || id.includes(q))    score = 40;
      else if (q.includes(name) && name.length > 3)    score = 25;

      if (score > 0) scored.push({ skill, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.skill);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SKILL RELATIONSHIPS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * All outbound relationships from a skill, optionally filtered by type.
   */
  getRelationships(skillId, type = null) {
    return this._relationships
      .filter(r =>
        r.skill_id === skillId &&
        (!type || r.relationship_type === type)
      )
      .map(r => ({
        ...r,
        related_skill: this._skills.get(r.related_skill_id) || null,
      }))
      .sort((a, b) => b.strength_score - a.strength_score);
  }

  /**
   * Direct prerequisites for a skill (shallow).
   */
  getDirectPrerequisites(skillId) {
    // _prereqsOf[skillId] contains edges where skill_id IS prereq OF skillId
    return (this._prereqsOf.get(skillId) || [])
      .map(r => ({
        ...r,
        skill: this._skills.get(r.skill_id) || { skill_id: r.skill_id },
      }))
      .sort((a, b) => b.strength_score - a.strength_score);
  }

  /**
   * Full transitive prerequisite tree for a skill.
   * Returns ordered list: learn these first → target skill last.
   */
  getPrerequisites(skillId, deep = true) {
    const visited = new Set();
    const result  = [];

    const traverse = (id, depth = 0) => {
      if (visited.has(id) || depth > 8) return;
      visited.add(id);

      // prereqsOf[id] = edges where skill_id is a prerequisite OF id
      const prereqs = this._prereqsOf.get(id) || [];
      const sorted  = [...prereqs].sort((a, b) => b.strength_score - a.strength_score);

      for (const rel of sorted) {
        // rel.skill_id is the prerequisite skill — recurse into IT first
        traverse(rel.skill_id, depth + 1);
      }

      if (id !== skillId) {
        const skill = this._skills.get(id);
        if (skill) result.push({ ...skill, depth });
      }
    };

    if (deep) {
      traverse(skillId);
    } else {
      return this.getDirectPrerequisites(skillId).map(r => r.skill).filter(Boolean);
    }

    const seen = new Set();
    return result.filter(s => {
      if (seen.has(s.skill_id)) return false;
      seen.add(s.skill_id);
      return true;
    });
  }

  getAdvancedSkills(skillId) {
    return (this._advancedOf.get(skillId) || [])
      .map(r => this._skills.get(r.related_skill_id))
      .filter(Boolean);
  }

  getRelatedSkills(skillId) {
    return (this._relatedTo.get(skillId) || [])
      .map(r => ({
        ...this._skills.get(r.related_skill_id),
        relationship_type: r.relationship_type,
        strength_score:    r.strength_score,
      }))
      .filter(s => s.skill_id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ROLE → SKILL MAP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Full skill map for a role with importance weights.
   * role_skills table equivalent: { role_id, skill_id, importance_weight }
   */
  getRoleSkillMap(roleId) {
    const map = this._roleSkills.get(roleId);
    if (!map) return { role_id: roleId, required: [], preferred: [], all: [] };

    const enrich = (entries) =>
      entries.map(e => ({
        ...e,
        skill: this._skills.get(e.skill_id) || { skill_id: e.skill_id },
      }));

    const required  = enrich(map.required);
    const preferred = enrich(map.preferred);

    return {
      role_id:   roleId,
      required,
      preferred,
      all:       [...required, ...preferred],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SKILL GAP DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detects missing skills for a target role given a user's current skills.
   *
   * @param {string[]|{name:string,skill_id?:string}[]} userSkills
   * @param {string} roleId
   * @returns {SkillGapResult}
   */
  detectGap(userSkills, roleId) {
    const roleMap = this.getRoleSkillMap(roleId);

    // Normalise user skills to a lookup set
    const userSet = this._normaliseUserSkills(userSkills);

    const matched         = [];
    const missing_required = [];
    const missing_preferred = [];

    for (const entry of roleMap.required) {
      const has = this._userHasSkill(entry.skill_id, entry.skill?.skill_name, userSet);
      if (has) matched.push(entry);
      else     missing_required.push(entry);
    }

    for (const entry of roleMap.preferred) {
      const has = this._userHasSkill(entry.skill_id, entry.skill?.skill_name, userSet);
      if (!has) missing_preferred.push(entry);
    }

    const required_total = matched.length + missing_required.length;
    const match_pct = required_total > 0
      ? Math.round((matched.length / required_total) * 100)
      : 0;

    // Weighted score: required 80%, preferred 20%
    const pref_total   = roleMap.preferred.length;
    const pref_matched = pref_total - missing_preferred.length;
    const pref_pct     = pref_total > 0 ? (pref_matched / pref_total) : 1;
    const skill_score  = Math.round(match_pct * 0.8 + pref_pct * 100 * 0.2);

    // Priority: sort missing by demand_score desc
    const priority_missing = [...missing_required]
      .sort((a, b) => (b.skill?.demand_score || 0) - (a.skill?.demand_score || 0))
      .slice(0, 8);

    return {
      role_id:           roleId,
      matched_skills:    matched,
      missing_required,
      missing_preferred,
      priority_missing,
      required_match_pct: match_pct,
      skill_score,            // 0-100 — used directly in CHI
      coverage_label:    this._coverageLabel(match_pct),
      required_total,
      matched_count:     matched.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LEARNING PATH GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generates a learning path to acquire a single missing skill.
   * Traverses the prerequisite graph to find which skills the user must learn
   * first, ordered from foundational → advanced.
   *
   * @param {string} targetSkillId — the skill the user wants to acquire
   * @param {string[]|object[]} userSkills — skills the user already has
   * @returns {LearningPath}
   */
  generateLearningPath(targetSkillId, userSkills = []) {
    const targetSkill = this._skills.get(targetSkillId);
    if (!targetSkill) {
      return {
        target_skill_id: targetSkillId,
        target_skill:    null,
        steps:           [],
        already_have:    [],
        total_steps:     0,
        estimated_weeks: 0,
      };
    }

    const userSet      = this._normaliseUserSkills(userSkills);
    const allPrereqs   = this.getPrerequisites(targetSkillId, true);

    const already_have = allPrereqs.filter(s =>
      this._userHasSkill(s.skill_id, s.skill_name, userSet)
    );
    const to_learn     = allPrereqs.filter(s =>
      !this._userHasSkill(s.skill_id, s.skill_name, userSet)
    );

    // Build ordered steps: prerequisites first, target last
    const steps = to_learn.map((skill, i) => ({
      step:             i + 1,
      skill_id:         skill.skill_id,
      skill_name:       skill.skill_name,
      skill_category:   skill.skill_category,
      difficulty_level: skill.difficulty_level,
      estimated_weeks:  this._estimateWeeks(skill.difficulty_level),
      reason:           `Prerequisite for ${targetSkill.skill_name}`,
      prerequisites_met: true, // all prior steps satisfy this
    }));

    // Add target skill as final step
    steps.push({
      step:             steps.length + 1,
      skill_id:         targetSkill.skill_id,
      skill_name:       targetSkill.skill_name,
      skill_category:   targetSkill.skill_category,
      difficulty_level: targetSkill.difficulty_level,
      estimated_weeks:  this._estimateWeeks(targetSkill.difficulty_level),
      reason:           'Target skill',
      is_target:        true,
    });

    const total_weeks = steps.reduce((s, step) => s + step.estimated_weeks, 0);

    return {
      target_skill_id: targetSkillId,
      target_skill:    targetSkill,
      steps,
      already_have:    already_have.map(s => s.skill_id),
      total_steps:     steps.length,
      estimated_weeks: total_weeks,
    };
  }

  /**
   * Generates learning paths for multiple missing skills.
   * Deduplicates shared prerequisites across paths and orders by priority.
   *
   * @param {object[]} missingSkills — from detectGap().priority_missing
   * @param {string[]|object[]} userSkills
   * @returns {LearningPaths}
   */
  generateLearningPaths(missingSkills, userSkills = []) {
    const userSet = this._normaliseUserSkills(userSkills);

    const paths = missingSkills.map(entry => {
      const path = this.generateLearningPath(entry.skill_id, userSkills);
      return {
        ...path,
        importance_weight: entry.importance_weight || 1.0,
        demand_score:      entry.skill?.demand_score || 5,
      };
    });

    // Sort: required skills first, then by demand score desc
    paths.sort((a, b) => {
      const wDiff = (b.importance_weight || 0) - (a.importance_weight || 0);
      if (wDiff !== 0) return wDiff;
      return (b.demand_score || 0) - (a.demand_score || 0);
    });

    // Build a global deduplicated step list across all paths
    const globalSteps = new Map(); // skill_id → step
    for (const path of paths) {
      for (const step of path.steps) {
        if (!globalSteps.has(step.skill_id)) {
          globalSteps.set(step.skill_id, {
            ...step,
            needed_for: [path.target_skill_id],
          });
        } else {
          globalSteps.get(step.skill_id).needed_for.push(path.target_skill_id);
        }
      }
    }

    // Re-number global steps ordered by difficulty_level asc
    const orderedSteps = Array.from(globalSteps.values())
      .sort((a, b) => (a.difficulty_level || 1) - (b.difficulty_level || 1))
      .map((step, i) => ({ ...step, step: i + 1 }));

    const total_weeks = orderedSteps.reduce((s, st) => s + (st.estimated_weeks || 0), 0);

    return {
      paths,
      global_learning_plan: orderedSteps,
      total_skills_to_learn: globalSteps.size,
      estimated_weeks:       total_weeks,
      estimated_months:      Math.ceil(total_weeks / 4),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CHI SKILL SCORE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Computes the skill component score for CHI.
   *
   * Formula:
   *   skill_score = (required_match_pct × 0.8 + preferred_match_pct × 0.2) × weight
   *
   * Also returns sub-scores per category (technical, soft, domain)
   * for dimensional CHI breakdown.
   *
   * @param {string[]|object[]} userSkills
   * @param {string} roleId
   * @param {number} weight — CHI weight for skill dimension (default 0.30)
   * @returns {SkillScore}
   */
  computeSkillScore(userSkills, roleId, weight = 0.30) {
    const gap      = this.detectGap(userSkills, roleId);
    const roleMap  = this.getRoleSkillMap(roleId);
    const userSet  = this._normaliseUserSkills(userSkills);

    // Per-category breakdown
    const categories = ['technical', 'soft', 'domain', 'tool'];
    const byCategory = {};

    for (const cat of categories) {
      const catRequired = roleMap.required.filter(
        e => (e.skill?.skill_category || 'technical') === cat
      );
      if (!catRequired.length) continue;

      const catMatched = catRequired.filter(e =>
        this._userHasSkill(e.skill_id, e.skill?.skill_name, userSet)
      );
      byCategory[cat] = {
        required: catRequired.length,
        matched:  catMatched.length,
        pct:      Math.round((catMatched.length / catRequired.length) * 100),
      };
    }

    return {
      role_id:            roleId,
      skill_score:        gap.skill_score,          // 0-100
      required_match_pct: gap.required_match_pct,   // 0-100
      coverage_label:     gap.coverage_label,
      weight,
      weighted_contribution: Math.round(gap.skill_score * weight * 100) / 100,
      by_category:        byCategory,
      missing_count:      gap.missing_required.length,
      matched_count:      gap.matched_count,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _normaliseUserSkills(userSkills = []) {
    const set = new Set();
    for (const s of userSkills) {
      const raw = typeof s === 'string' ? s : (s.name || s.skill_id || s.skill_name || '');
      if (raw) {
        set.add(norm(raw));
        // Also add underscore slug form
        set.add(raw.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
      }
    }
    return set;
  }

  _userHasSkill(skillId, skillName, userSet) {
    if (!skillId && !skillName) return false;
    if (skillId && userSet.has(skillId)) return true;
    if (skillId && userSet.has(skillId.replace(/_/g, ' '))) return true;
    if (skillName && userSet.has(norm(skillName))) return true;
    // Partial match: user has "python" → matches "python_basics"
    if (skillId) {
      const idNorm = norm(skillId.replace(/_/g, ' '));
      for (const u of userSet) {
        if (idNorm.includes(u) && u.length > 3) return true;
        if (u.includes(idNorm) && idNorm.length > 3) return true;
      }
    }
    return false;
  }

  _estimateWeeks(difficultyLevel) {
    const map = { 1: 2, 2: 4, 3: 6, 4: 8, 5: 12 };
    return map[difficultyLevel] || 4;
  }

  _coverageLabel(pct) {
    if (pct >= 80) return 'strong';
    if (pct >= 60) return 'moderate';
    if (pct >= 40) return 'partial';
    return 'low';
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────
const skillGraph = new SkillGraph().load();
module.exports = skillGraph;
module.exports.SkillGraph = SkillGraph;








