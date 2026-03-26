'use strict';

/**
 * CareerGraph.js — Career Graph Intelligence Engine
 *
 * This is the single source of truth for all career graph operations in HireRise.
 * It replaces the fragmented approach of BUILTIN_ROLE_SKILLS maps, static JSON
 * repos, and disconnected salary/education lookups with a unified graph engine.
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  career-graph/                                                      │
 *   │    {family}/{role_id}.json   — role nodes (skills, salary, edu)    │
 *   │    role_transitions.json     — directed graph edges                 │
 *   │    skills_registry.json      — canonical skills catalogue           │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Public API:
 *   graph.getRole(roleId)                           → RoleNode | null
 *   graph.resolveRole(titleOrId)                    → RoleNode | null  (fuzzy match)
 *   graph.getSkillsForRole(roleId)                  → SkillEntry[]
 *   graph.getSkillGap(userSkills, roleId)           → SkillGapResult
 *   graph.getTransitions(fromRoleId, opts?)         → TransitionEdge[]
 *   graph.getCareerPath(fromRoleId, hops?)          → CareerPathResult
 *   graph.getSalaryBenchmark(roleId, opts?)         → SalaryBenchmark
 *   graph.getEducationMatch(roleId, eduLevel)       → EducationMatch
 *   graph.computeCHI(profile)                       → CHIScore
 *   graph.getRoleFamilies()                         → string[]
 *   graph.getRolesByFamily(family)                  → RoleNode[]
 *   graph.searchRoles(query, limit?)               → RoleNode[]
 *   graph.allRoles()                               → RoleNode[]
 */

const fs   = require('fs');
const path = require('path');

const GRAPH_DIR = path.join(__dirname, '../../data/career-graph');

// ─── Normalise a string for fuzzy matching ────────────────────────────────────
const norm = (s = '') => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

class CareerGraph {
  constructor() {
    this._roles       = new Map();  // role_id → RoleNode
    this._transitions = [];         // TransitionEdge[]
    this._skills      = new Map();  // skill_id → SkillDef
    this._loaded      = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOOT — load all JSON data files eagerly at startup
  // ═══════════════════════════════════════════════════════════════════════════

  load() {
    if (this._loaded) return this;

    // 1. Role nodes
    const families = fs.readdirSync(GRAPH_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const family of families) {
      const dir = path.join(GRAPH_DIR, family);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const node = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          if (node.role_id) {
            this._roles.set(node.role_id, node);
          }
        } catch (e) {
          // skip malformed files
        }
      }
    }

    // 2. Transitions
    try {
      const txFile = path.join(GRAPH_DIR, 'role_transitions.json');
      const txData = JSON.parse(fs.readFileSync(txFile, 'utf8'));
      this._transitions = txData.transitions || [];
    } catch (e) {
      this._transitions = [];
    }

    // 3. Skills registry
    try {
      const skFile = path.join(GRAPH_DIR, 'skills_registry.json');
      const skData = JSON.parse(fs.readFileSync(skFile, 'utf8'));
      for (const skill of (skData.skills || [])) {
        this._skills.set(skill.skill_id, skill);
      }
    } catch (e) {
      // skills registry optional — degrade gracefully
    }

    this._loaded = true;
    return this;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ROLE LOOKUP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Exact lookup by role_id.
   */
  getRole(roleId) {
    if (!roleId) return null;
    return this._roles.get(roleId) || null;
  }

  /**
   * Fuzzy lookup — tries exact role_id first, then title match.
   * Used when onboarding provides a free-text title instead of a structured ID.
   */
  resolveRole(titleOrId) {
    if (!titleOrId) return null;
    const str = String(titleOrId).trim();

    // 1. Exact role_id
    if (this._roles.has(str)) return this._roles.get(str);

    // 2. Normalised title match
    const query = norm(str);
    let bestScore = 0;
    let bestNode  = null;

    for (const node of this._roles.values()) {
      const title = norm(node.title || '');
      let score = 0;
      if (title === query)              score = 100;
      else if (title.startsWith(query)) score = 70;
      else if (title.includes(query))   score = 40;
      else if (query.includes(title) && title.length > 4) score = 30;

      if (score > bestScore) { bestScore = score; bestNode = node; }
    }

    return bestScore >= 30 ? bestNode : null;
  }

  allRoles() {
    return Array.from(this._roles.values());
  }

  getRoleFamilies() {
    const families = new Set(Array.from(this._roles.values()).map(r => r.job_family).filter(Boolean));
    return Array.from(families).sort();
  }

  getRolesByFamily(family) {
    if (!family) return [];
    const q = norm(family);
    return Array.from(this._roles.values())
      .filter(r => norm(r.job_family || '') === q)
      .sort((a, b) => (a.level_order || 0) - (b.level_order || 0));
  }

  searchRoles(query, limit = 15) {
    if (!query || !String(query).trim()) return this.allRoles().slice(0, limit);
    const q = norm(query);

    const scored = [];
    for (const node of this._roles.values()) {
      const title = norm(node.title || '');
      let score = 0;
      if (title === q)                   score = 100;
      else if (title.startsWith(q))      score = 70;
      else if (title.includes(q))        score = 50;
      else if (q.includes(title) && title.length > 3) score = 35;
      // Also check job_family
      const fam = norm(node.job_family || '');
      if (fam.includes(q)) score = Math.max(score, 25);

      if (score > 0) scored.push({ node, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.node);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SKILLS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns enriched skill entries for a role, merging required + preferred.
   * Output shape: { skill_id, skill_name, skill_category, importance, demand_score }
   */
  getSkillsForRole(roleId) {
    const node = this.getRole(roleId) || this.resolveRole(roleId);
    if (!node) return [];

    const required  = (node.required_skills  || []).map(id => ({ id, importance: 'required' }));
    const preferred = (node.preferred_skills || []).map(id => ({ id, importance: 'preferred' }));

    return [...required, ...preferred].map(({ id, importance }) => {
      const def = this._skills.get(id) || {};
      return {
        skill_id:       id,
        skill_name:     def.skill_name    || this._idToLabel(id),
        skill_category: def.skill_category || 'technical',
        importance,
        demand_score:   def.demand_score  || 5,
      };
    });
  }

  /**
   * Convert a skill slug to a readable label when not in registry.
   * python_advanced → "Python Advanced"
   */
  _idToLabel(id) {
    return (id || '')
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SKILL GAP ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Computes the gap between a user's skills and a target role's required skills.
   *
   * @param {string[]|{name:string}[]} userSkills
   * @param {string} roleId
   * @returns {SkillGapResult}
   */
  getSkillGap(userSkills, roleId) {
    const node = this.getRole(roleId) || this.resolveRole(roleId);
    const roleSkills = this.getSkillsForRole(roleId);

    // Normalise user skills to a set of lowercased strings
    const userSet = new Set(
      (userSkills || []).map(s => {
        const raw = typeof s === 'string' ? s : (s.name || '');
        return norm(raw);
      })
    );

    const matched = [];
    const missing = [];
    const preferred_gaps = [];

    for (const skill of roleSkills) {
      const label = norm(skill.skill_name);
      const id    = norm(skill.skill_id);
      const has   = userSet.has(label) || userSet.has(id)
        || Array.from(userSet).some(u => label.includes(u) || u.includes(id.replace(/_/g, ' ')));

      if (skill.importance === 'required') {
        if (has) matched.push(skill);
        else     missing.push(skill);
      } else {
        if (!has) preferred_gaps.push(skill);
      }
    }

    const required_total = matched.length + missing.length;
    const match_pct = required_total > 0
      ? Math.round((matched.length / required_total) * 100)
      : 0;

    // Weighted score: required skills are 80% of the score, preferred 20%
    const preferred_total   = preferred_gaps.length;
    const preferred_matched = roleSkills.filter(s => s.importance === 'preferred').length - preferred_total;
    const preferred_pct     = (roleSkills.filter(s => s.importance === 'preferred').length > 0)
      ? preferred_matched / roleSkills.filter(s => s.importance === 'preferred').length
      : 1;

    const skill_match_score = Math.round(match_pct * 0.8 + preferred_pct * 100 * 0.2);

    return {
      role_id:         roleId,
      role_title:      node?.title || roleId,
      matched_skills:  matched,
      missing_required: missing,
      preferred_gaps,
      required_match_pct:  match_pct,
      skill_match_score,   // 0-100, used in CHI
      required_count:  required_total,
      matched_count:   matched.length,
      coverage_label:  this._coverageLabel(match_pct),
      priority_skills: missing
        .sort((a, b) => (b.demand_score || 0) - (a.demand_score || 0))
        .slice(0, 5),     // top 5 highest-demand missing skills
    };
  }

  _coverageLabel(pct) {
    if (pct >= 80) return 'strong';
    if (pct >= 60) return 'moderate';
    if (pct >= 40) return 'partial';
    return 'low';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CAREER TRANSITIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns all outbound transitions from a role.
   *
   * @param {string} fromRoleId
   * @param {{ types?: string[], minProbability?: number }} opts
   */
  getTransitions(fromRoleId, opts = {}) {
    const { types = null, minProbability = 0 } = opts;
    const edges = this._transitions.filter(e =>
      e.from_role_id === fromRoleId &&
      e.probability >= minProbability &&
      (!types || types.includes(e.transition_type))
    );

    return edges.map(edge => {
      const toNode = this.getRole(edge.to_role_id);
      return {
        ...edge,
        to_role_title:    toNode?.title          || edge.to_role_id,
        to_role_family:   toNode?.job_family     || null,
        to_seniority:     toNode?.seniority_level || null,
        to_salary_median: toNode?.salary?.median  || null,
        salary_delta:     this._salaryDelta(fromRoleId, edge.to_role_id),
      };
    }).sort((a, b) => b.probability - a.probability);
  }

  _salaryDelta(fromId, toId) {
    const from = this.getRole(fromId);
    const to   = this.getRole(toId);
    if (!from?.salary?.median || !to?.salary?.median) return null;
    const delta = to.salary.median - from.salary.median;
    const pct   = Math.round((delta / from.salary.median) * 100);
    return { absolute: delta, percent: pct, currency: from.salary.currency || 'INR' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CAREER PATH PROJECTION (multi-hop BFS)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Projects a career path from a starting role using BFS over the transition graph.
   * Returns the most probable path up to maxHops steps.
   *
   * @param {string} fromRoleId
   * @param {{ maxHops?: number, minProbability?: number, types?: string[] }} opts
   * @returns {CareerPathResult}
   */
  getCareerPath(fromRoleId, opts = {}) {
    const { maxHops = 4, minProbability = 0.15, types = null } = opts;
    const startNode = this.getRole(fromRoleId);

    if (!startNode) {
      return { error: `Role not found: ${fromRoleId}`, steps: [], total_years: 0 };
    }

    // BFS — at each hop, pick the highest-probability transition of each type
    const path    = [{ role: startNode, step: 0, cumulative_years: 0 }];
    const visited = new Set([fromRoleId]);
    let   current = fromRoleId;
    let   cum_years = 0;

    for (let hop = 0; hop < maxHops; hop++) {
      const transitions = this.getTransitions(current, { types, minProbability })
        .filter(t => !visited.has(t.to_role_id));

      if (!transitions.length) break;

      // Pick vertical > lateral by highest probability
      const best = transitions[0];
      const toNode = this.getRole(best.to_role_id);
      if (!toNode) break;

      cum_years += best.years_required;
      visited.add(best.to_role_id);

      path.push({
        role:                toNode,
        step:                hop + 1,
        transition_type:     best.transition_type,
        probability:         best.probability,
        years_to_transition: best.years_required,
        cumulative_years:    Math.round(cum_years * 10) / 10,
        salary_delta:        best.salary_delta,
      });

      current = best.to_role_id;
      if (toNode.is_terminal) break;
    }

    // Also collect alternate paths (non-primary transitions at step 1)
    const alternates = fromRoleId ? this.getTransitions(fromRoleId, { minProbability })
      .slice(1)  // skip the primary path
      .map(t => ({
        role:           this.getRole(t.to_role_id),
        transition_type: t.transition_type,
        probability:    t.probability,
        years_required: t.years_required,
      }))
      .filter(a => a.role) : [];

    return {
      from_role:       startNode,
      primary_path:    path,
      alternate_paths: alternates,
      total_years:     cum_years,
      terminal_role:   path[path.length - 1]?.role || null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SALARY BENCHMARK
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns salary benchmark for a role, optionally adjusted by country/currency.
   *
   * @param {string} roleId
   * @param {{ country?: string, experienceYears?: number, currency?: string }} opts
   */
  getSalaryBenchmark(roleId, opts = {}) {
    const { country = 'IN', experienceYears = null, currency = null } = opts;
    const node = this.getRole(roleId) || this.resolveRole(roleId);
    if (!node) return null;

    // Pick the salary object matching currency preference
    const useUSD = currency === 'USD' || (country !== 'IN' && country !== 'India');
    const salaryData = (useUSD && node.salary_usd) ? node.salary_usd : (node.salary || node.salary_usd);

    if (!salaryData) return null;

    // Experience adjustment: ±5% per year over/under role midpoint
    let multiplier = 1.0;
    if (experienceYears !== null) {
      const midExp = ((node.min_experience_years || 0) + (node.max_experience_years || 10)) / 2;
      const delta  = experienceYears - midExp;
      multiplier   = Math.max(0.8, Math.min(1.3, 1 + delta * 0.025));
    }

    const apply = v => v ? Math.round(v * multiplier) : null;

    return {
      role_id:          roleId,
      role_title:       node.title,
      currency:         salaryData.currency || 'INR',
      min:              apply(salaryData.min),
      p25:              apply(salaryData.p25),
      median:           apply(salaryData.median),
      p75:              apply(salaryData.p75),
      max:              apply(salaryData.max),
      experience_adj:   multiplier !== 1.0,
      multiplier:       Math.round(multiplier * 100) / 100,
    };
  }

  /**
   * Given a user's current salary, position them within the role's benchmark.
   * Returns percentile estimate and label.
   */
  getSalaryPosition(roleId, currentSalaryAnnual, opts = {}) {
    const bench = this.getSalaryBenchmark(roleId, opts);
    if (!bench || !currentSalaryAnnual) return null;

    let percentile;
    const s = currentSalaryAnnual;
    if      (s >= bench.p75)  percentile = 75 + Math.min(25, ((s - bench.p75) / (bench.max - bench.p75 || 1)) * 25);
    else if (s >= bench.median) percentile = 50 + ((s - bench.median) / (bench.p75 - bench.median || 1)) * 25;
    else if (s >= bench.p25)  percentile = 25 + ((s - bench.p25)    / (bench.median - bench.p25 || 1)) * 25;
    else                       percentile = Math.max(5, (s / bench.p25) * 25);

    percentile = Math.round(Math.min(99, Math.max(1, percentile)));

    const label =
      percentile >= 75 ? 'above_market'   :
      percentile >= 45 ? 'at_market'      :
      percentile >= 25 ? 'below_market'   :
                         'significantly_below_market';

    return {
      percentile,
      label,
      current:       s,
      benchmark:     bench,
      gap_to_median: bench.median - s,
      gap_to_p75:    bench.p75 - s,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EDUCATION MATCH
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns education match score (0-100) for a candidate's education level vs
   * the role's expected education.
   *
   * @param {string} roleId
   * @param {string} eduLevel  — 'high_school' | 'diploma' | 'bachelors' | 'masters' | 'mba' | 'phd'
   * @returns {EducationMatch}
   */
  getEducationMatch(roleId, eduLevel) {
    const node = this.getRole(roleId) || this.resolveRole(roleId);
    if (!node || !eduLevel) return { score: 50, label: 'unknown', benchmark_pct: 50 };

    const scores      = node.education?.match_scores || {};
    const preferred   = node.education?.preferred_levels || [];
    const score       = scores[eduLevel] ?? this._defaultEduScore(eduLevel);
    const isPref      = preferred.includes(eduLevel);

    return {
      role_id:         roleId,
      education_level: eduLevel,
      score,                          // 0-100
      preferred_levels: preferred,
      is_preferred:    isPref,
      label:           this._eduLabel(score),
      benchmark_pct:   score,         // alias for CHI consumers
    };
  }

  _defaultEduScore(level) {
    const defaults = { phd: 88, masters: 85, mba: 85, bachelors: 78, diploma: 55, high_school: 30 };
    return defaults[level] || 50;
  }

  _eduLabel(score) {
    if (score >= 85) return 'exceeds_requirements';
    if (score >= 70) return 'meets_requirements';
    if (score >= 50) return 'partially_meets';
    return 'below_requirements';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CAREER HEALTH INDEX (CHI) — GRAPH-POWERED
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Computes a deterministic Career Health Index from graph data.
   *
   * Components (weights must sum to 1.0):
   *   skill_match          0.30  — % of required role skills the candidate has
   *   experience_alignment 0.25  — years experience vs role requirement band
   *   education_match      0.15  — education level vs role preference
   *   salary_position      0.15  — current salary vs market benchmark
   *   career_velocity      0.15  — transitions on track / ahead / behind
   *
   * @param {CHIProfile} profile
   * @returns {CHIResult}
   */
  computeCHI(profile) {
    const {
      targetRoleId,
      currentRoleId       = null,
      userSkills          = [],
      experienceYears     = 0,
      educationLevel      = null,
      currentSalaryAnnual = null,
      country             = 'IN',
    } = profile;

    const targetNode  = this.getRole(targetRoleId) || this.resolveRole(targetRoleId);
    if (!targetNode) {
      return this._fallbackCHI('Target role not found in career graph');
    }

    // ── 1. Skill Match (0–100) — SkillGraph engine preferred ─────────────────
    let skillScore;
    let gapResult;
    try {
      const skillGraph = require('../skillGraph/SkillGraph');
      const sgScore    = skillGraph.computeSkillScore(userSkills, targetRoleId, 1.0);
      skillScore       = sgScore.skill_score;
      // Also get gap result for the detail block below
      gapResult        = skillGraph.detectGap(userSkills, targetRoleId);
    } catch (_) {
      // Fallback to CareerGraph's built-in gap calculation
      gapResult  = this.getSkillGap(userSkills, targetRoleId);
      skillScore = gapResult.skill_match_score;
    }

    // ── 2. Experience Alignment (0–100) ──────────────────────────────────────
    const expMin = targetNode.min_experience_years || 0;
    const expMax = targetNode.max_experience_years || 15;
    let expScore;
    if (experienceYears >= expMin && experienceYears <= expMax) {
      expScore = 100;
    } else if (experienceYears < expMin) {
      const gap    = expMin - experienceYears;
      expScore     = Math.max(0, Math.round(100 - gap * 15));
    } else {
      const over   = experienceYears - expMax;
      expScore     = Math.max(60, Math.round(100 - over * 8));
    }

    // ── 3. Education Match (0–100) ────────────────────────────────────────────
    const eduResult  = this.getEducationMatch(targetRoleId, educationLevel);
    const eduScore   = eduResult.score;

    // ── 4. Salary Benchmark Position (0–100) ─────────────────────────────────
    let salaryScore = 50; // neutral default when no salary data
    const salaryPos  = currentSalaryAnnual
      ? this.getSalaryPosition(targetRoleId, currentSalaryAnnual, { country })
      : null;
    if (salaryPos) {
      // Higher percentile = higher salary position score
      // But being at market (p50) is ideal — extreme under-pay hurts career health
      salaryScore = salaryPos.percentile >= 50
        ? Math.min(100, 50 + (salaryPos.percentile - 50) * 0.8)
        : Math.max(20, salaryPos.percentile);
      salaryScore = Math.round(salaryScore);
    }

    // ── 5. Career Velocity (0–100) ────────────────────────────────────────────
    // Measures whether the user's current role is on a recognised transition
    // path toward the target role, and how direct that path is.
    const velocityScore = this._computeVelocity(currentRoleId, targetRoleId, experienceYears);

    // ── Weighted composite ────────────────────────────────────────────────────
    const WEIGHTS = {
      skill_match:          0.30,
      experience_alignment: 0.25,
      education_match:      0.15,
      salary_position:      0.15,
      career_velocity:      0.15,
    };

    const chiScore = Math.round(
      skillScore   * WEIGHTS.skill_match          +
      expScore     * WEIGHTS.experience_alignment  +
      eduScore     * WEIGHTS.education_match       +
      salaryScore  * WEIGHTS.salary_position       +
      velocityScore * WEIGHTS.career_velocity
    );

    const dimensions = {
      skill_match:          { score: skillScore,    weight: WEIGHTS.skill_match,          insight: gapResult.coverage_label },
      experience_alignment: { score: expScore,      weight: WEIGHTS.experience_alignment,  insight: this._expLabel(expScore) },
      education_match:      { score: eduScore,      weight: WEIGHTS.education_match,       insight: eduResult.label },
      salary_position:      { score: salaryScore,   weight: WEIGHTS.salary_position,       insight: salaryPos?.label || 'no_data' },
      career_velocity:      { score: velocityScore, weight: WEIGHTS.career_velocity,       insight: this._velocityLabel(velocityScore) },
    };

    return {
      chi_score:          chiScore,
      readiness_label:    this._readinessLabel(chiScore),
      dimensions,
      details: {
        skill_gap:       gapResult,
        salary_position: salaryPos,
        education_match: eduResult,
        career_path:     currentRoleId ? this.getCareerPath(currentRoleId) : null,
      },
      target_role:       targetNode,
      computed_at:       new Date().toISOString(),
      source:            'career_graph',
    };
  }

  /**
   * Career Velocity — graph-distance score between current and target role.
   * On a direct path = 100, one hop away = 80, two hops = 60, no path = 30
   */
  _computeVelocity(currentRoleId, targetRoleId, experienceYears = 0) {
    if (!currentRoleId) return 50;   // no current role info
    if (currentRoleId === targetRoleId) return 100; // already there

    // BFS up to 4 hops
    const visited = new Set([currentRoleId]);
    const queue   = [{ id: currentRoleId, hops: 0 }];

    while (queue.length) {
      const { id, hops } = queue.shift();
      if (hops >= 4) continue;

      const transitions = this._transitions.filter(t => t.from_role_id === id);
      for (const t of transitions) {
        if (t.to_role_id === targetRoleId) {
          // Found — score based on distance
          const baseScore = Math.max(40, 100 - hops * 20);

          // Bonus if experience is appropriate for role
          const targetNode = this.getRole(targetRoleId);
          const yearsNeeded = targetNode?.min_experience_years || 0;
          const expBonus = experienceYears >= yearsNeeded * 0.7 ? 10 : 0;

          return Math.min(100, baseScore + expBonus);
        }
        if (!visited.has(t.to_role_id)) {
          visited.add(t.to_role_id);
          queue.push({ id: t.to_role_id, hops: hops + 1 });
        }
      }
    }

    return 30; // no known path — still achievable but not on graph
  }

  _readinessLabel(score) {
    if (score >= 85) return 'Highly Ready';
    if (score >= 70) return 'Ready';
    if (score >= 55) return 'Moderately Ready';
    if (score >= 40) return 'Partially Ready';
    return 'Needs Development';
  }

  _expLabel(score) {
    if (score >= 100) return 'on_track';
    if (score >= 70)  return 'slightly_under';
    if (score >= 40)  return 'under_experienced';
    return 'significantly_under';
  }

  _velocityLabel(score) {
    if (score >= 90) return 'direct_path';
    if (score >= 70) return 'one_hop';
    if (score >= 50) return 'multi_hop';
    if (score >= 30) return 'lateral_pivot';
    return 'off_path';
  }

  _fallbackCHI(reason) {
    return {
      chi_score:       null,
      readiness_label: 'Insufficient Data',
      dimensions:      {},
      error:           reason,
      source:          'career_graph',
    };
  }

  /**
   * Lightweight version for onboarding — same CHI but returns only essential
   * fields to keep the onboarding API payload small.
   */
  computeOnboardingInsights(profile) {
    const chi = this.computeCHI(profile);
    if (chi.error) return chi;

    const path    = profile.currentRoleId
      ? this.getCareerPath(profile.currentRoleId)
      : this.getCareerPath(profile.targetRoleId, { maxHops: 3 });

    const salary  = this.getSalaryBenchmark(profile.targetRoleId, {
      country: profile.country || 'IN',
      experienceYears: profile.experienceYears,
    });

    return {
      chi_score:         chi.chi_score,
      readiness_label:   chi.readiness_label,
      skill_match_pct:   chi.details.skill_gap?.required_match_pct || 0,
      missing_skills:    chi.details.skill_gap?.priority_skills     || [],
      education_match:   chi.details.education_match,
      salary_benchmark:  salary,
      career_path: {
        steps: path.primary_path.map(s => ({
          role_id:   s.role?.role_id,
          title:     s.role?.title,
          years:     s.cumulative_years,
          salary:    s.role?.salary?.median,
        })),
        total_years: path.total_years,
      },
      dimensions:        chi.dimensions,
    };
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
// Load once at module require-time so all consumers share one in-memory graph.
const careerGraph = new CareerGraph().load();

module.exports = careerGraph;
module.exports.CareerGraph = CareerGraph; // also export class for testing








