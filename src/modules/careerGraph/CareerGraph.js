'use strict';

/**
 * Supabase-native Career Graph Intelligence Engine
 * Fully aligned with live SQL graph schema.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase =
  global.__HIRERISE_SUPABASE__ ||
  (global.__HIRERISE_SUPABASE__ = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  ));

const norm = (s = '') =>
  String(s)
    .toLowerCase()
    .trim();

class CareerGraph {
  constructor() {
    this.roleCache = new Map();
    this.skillCache = new Map();
    this.transitionCache = new Map();
  }

  async getRole(roleId) {
    if (!roleId) return null;

    const normalized = norm(roleId);

    if (this.roleCache.has(normalized)) {
      return this.roleCache.get(normalized);
    }

    const { data, error } = await supabase
      .from('career_roles')
      .select('*')
      .eq('role_id', normalized)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      this.roleCache.set(normalized, data);
    }

    return data || null;
  }

  async resolveRole(titleOrId) {
    if (!titleOrId) return null;

    const normalized = norm(titleOrId);

    const exact = await this.getRole(normalized);
    if (exact) return exact;

    const { data, error } = await supabase
      .from('career_roles')
      .select('*')
      .ilike('title', `%${normalized}%`)
      .limit(10);

    if (error) throw error;
    return data?.[0] || null;
  }

  async allRoles() {
    const { data, error } = await supabase
      .from('career_roles')
      .select('*')
      .order('seniority_rank', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async getRoleFamilies() {
    const { data, error } = await supabase
      .from('career_roles')
      .select('role_family')
      .not('role_family', 'is', null);

    if (error) throw error;

    return [...new Set((data || []).map((r) => r.role_family))]
      .filter(Boolean)
      .sort();
  }

  async getRolesByFamily(family) {
    if (!family) return [];

    const { data, error } = await supabase
      .from('career_roles')
      .select('*')
      .eq('role_family', family)
      .order('seniority_rank', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async searchRoles(query, limit = 15) {
    if (!query?.trim()) {
      const rows = await this.allRoles();
      return rows.slice(0, limit);
    }

    const { data, error } = await supabase
      .from('career_roles')
      .select('*')
      .ilike('title', `%${query.trim()}%`)
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  async getSkillsForRole(roleId) {
    const node =
      (await this.getRole(roleId)) ||
      (await this.resolveRole(roleId));

    if (!node) return [];

    const ids = [
      ...(node.required_skills || []).map((id) => ({
        id,
        importance: 'required',
      })),
      ...(node.preferred_skills || []).map((id) => ({
        id,
        importance: 'preferred',
      })),
    ];

    if (!ids.length) return [];

    const { data, error } = await supabase
      .from('career_skills_registry')
      .select('*')
      .in(
        'skill_id',
        ids.map((x) => x.id)
      );

    if (error) throw error;

    const defs = new Map(
      (data || []).map((skill) => [skill.skill_id, skill])
    );

    return ids.map(({ id, importance }) => {
      const def = defs.get(id) || {};

      return {
        skill_id: id,
        skill_name: def.skill_name || this._idToLabel(id),
        skill_category: def.skill_category || 'technical',
        importance,
        demand_score: def.demand_score || 5,
      };
    });
  }

  _idToLabel(id) {
    return String(id || '')
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  async getTransitions(fromRoleId, opts = {}) {
    const normalized = norm(fromRoleId);
    const {
      types = null,
      maxDifficulty = 100,
    } = opts;

    let query = supabase
      .from('career_role_transitions')
      .select('*')
      .eq('from_role_id', normalized)
      .lte('difficulty_score', maxDifficulty)
      .order('difficulty_score', { ascending: true });

    if (types?.length) {
      query = query.in('transition_type', types);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data || [];
  }

  async getCareerPath(fromRoleId, opts = {}) {
    const {
      maxHops = 4,
      maxDifficulty = 100,
      types = null,
    } = opts;

    const startNode = await this.getRole(fromRoleId);

    if (!startNode) {
      return {
        error: `Role not found: ${fromRoleId}`,
        steps: [],
        total_years: 0,
      };
    }

    const path = [
      {
        role: startNode,
        step: 0,
        cumulative_years: 0,
      },
    ];

    const visited = new Set([startNode.role_id]);
    let current = startNode.role_id;
    let totalYears = 0;

    for (let hop = 0; hop < maxHops; hop++) {
      const transitions = await this.getTransitions(current, {
        types,
        maxDifficulty,
      });

      const next = transitions.find(
        (t) => !visited.has(t.to_role_id)
      );

      if (!next) break;

      const role = await this.getRole(next.to_role_id);
      if (!role) break;

      totalYears += next.avg_transition_years || 0;
      visited.add(next.to_role_id);

      path.push({
        role,
        step: hop + 1,
        transition_type: next.transition_type,
        difficulty_score: next.difficulty_score,
        years_to_transition: next.avg_transition_years,
        cumulative_years: totalYears,
      });

      current = next.to_role_id;
    }

    return {
      from_role: startNode,
      primary_path: path,
      total_years: totalYears,
      terminal_role: path[path.length - 1]?.role || null,
    };
  }
}

module.exports = new CareerGraph();
module.exports.CareerGraph = CareerGraph;