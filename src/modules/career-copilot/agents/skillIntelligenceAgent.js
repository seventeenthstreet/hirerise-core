'use strict';

/**
 * src/modules/career-copilot/agents/skillIntelligenceAgent.js
 *
 * Skill graph + skill gap intelligence agent.
 * Production hardened for:
 * - parallel graph + gap analysis
 * - optional semantic enrichment
 * - stable recommendation ranking
 * - safe null handling
 */

const BaseAgent = require('./baseAgent');
const logger = require('../../../utils/logger');

const skillGraphEngine = safeRequire(
  '../../../modules/jobSeeker/skillGraphEngine.service',
  'SkillGraphEngine'
);

const semanticSkillEngine = safeRequire(
  '../../../engines/semanticSkill.engine',
  'SemanticSkillEngine'
);

class SkillIntelligenceAgent extends BaseAgent {
  get agentName() {
    return 'SkillIntelligenceAgent';
  }

  get cachePrefix() {
    return 'agent:skill';
  }

  /**
   * @param {string} userId
   * @param {object} context
   * @returns {Promise<object>}
   */
  async run(userId, context = {}) {
    if (!skillGraphEngine) {
      throw new Error('SkillGraphEngine unavailable');
    }

    const [graph, gap] = await this._fetchSkillData(userId);

    const semanticNeighbours = await this._getSemanticNeighbours(gap);

    const missingHighDemand = this._normalizeMissingSkills(
      gap?.missing_high_demand
    );

    const recommendedSkills = this._buildRecommendations(
      missingHighDemand,
      semanticNeighbours
    );

    return {
      existing_skills: this._safeArray(graph?.existing_skills),
      adjacent_skills: this._safeArray(graph?.adjacent_skills),
      next_level_skills: this._safeArray(graph?.next_level_skills),
      role_specific_skills: this._safeArray(graph?.role_specific_skills),
      missing_high_demand: missingHighDemand,
      role_gap: gap?.role_gap || null,
      learning_paths: this._normalizeLearningPaths(gap?.learning_paths),
      semantic_neighbours: semanticNeighbours,
      recommended_skills: recommendedSkills,
      target_role: graph?.target_role || gap?.target_role || null,
      industry: graph?.industry || null,
      skill_count: Number(graph?.skill_count || 0),
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Data fetch
  // ────────────────────────────────────────────────────────────────────────────

  async _fetchSkillData(userId) {
    const [graphRes, gapRes] = await Promise.allSettled([
      skillGraphEngine.getUserSkillGraph(userId),
      skillGraphEngine.detectSkillGap(userId),
    ]);

    const graph =
      graphRes.status === 'fulfilled' ? graphRes.value : null;
    const gap =
      gapRes.status === 'fulfilled' ? gapRes.value : null;

    if (graphRes.status === 'rejected') {
      logger.warn(
        '[SkillIntelligenceAgent] getUserSkillGraph failed',
        {
          userId,
          error: graphRes.reason?.message || 'Unknown graph error',
        }
      );
    }

    if (gapRes.status === 'rejected') {
      logger.warn(
        '[SkillIntelligenceAgent] detectSkillGap failed',
        {
          userId,
          error: gapRes.reason?.message || 'Unknown gap error',
        }
      );
    }

    return [graph, gap];
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Semantic enrichment
  // ────────────────────────────────────────────────────────────────────────────

  async _getSemanticNeighbours(gap) {
    const semanticEnabled =
      String(process.env.FEATURE_SEMANTIC_MATCHING).toLowerCase() === 'true';

    if (
      !semanticEnabled ||
      !semanticSkillEngine?.findSimilarSkills
    ) {
      return [];
    }

    const topMissing = this._safeArray(gap?.missing_high_demand)
      .slice(0, 3)
      .map((skill) =>
        typeof skill === 'string'
          ? skill
          : skill?.name
      )
      .filter(Boolean);

    if (!topMissing.length) {
      return [];
    }

    const results = await Promise.allSettled(
      topMissing.map((skillName) =>
        semanticSkillEngine.findSimilarSkills(skillName, {
          topK: 3,
          minScore: 0.7,
        })
      )
    );

    const dedupe = new Set();

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;

      for (const skill of result.value || []) {
        const name = skill?.skill_name || skill?.name;
        if (name) dedupe.add(name);
      }
    }

    return [...dedupe].slice(0, 6);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Builders
  // ────────────────────────────────────────────────────────────────────────────

  _normalizeMissingSkills(rawSkills = []) {
    return this._safeArray(rawSkills)
      .slice(0, 8)
      .map((skill) =>
        typeof skill === 'string'
          ? {
              name: skill,
              demand_score: null,
              category: null,
            }
          : {
              name: skill?.name || null,
              demand_score:
                skill?.demand_score != null
                  ? this._safeScore(skill.demand_score)
                  : null,
              category: skill?.category || null,
            }
      )
      .filter((skill) => skill.name);
  }

  _normalizeLearningPaths(paths = []) {
    return this._safeArray(paths)
      .slice(0, 3)
      .map((path) => ({
        skill: path?.skill || null,
        path: this._safeArray(path?.path).slice(0, 6),
      }))
      .filter((item) => item.skill);
  }

  _buildRecommendations(missingHighDemand, semanticNeighbours) {
    const ordered = [];
    const seen = new Set();

    for (const skill of missingHighDemand) {
      const name = skill?.name;
      if (name && !seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }

    for (const neighbour of semanticNeighbours) {
      if (neighbour && !seen.has(neighbour)) {
        seen.add(neighbour);
        ordered.push(neighbour);
      }
    }

    return ordered.slice(0, 10);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  _safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  _safeScore(value) {
    const numeric = Number(value || 0);
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }
}

function safeRequire(path, name) {
  try {
    return require(path);
  } catch (err) {
    logger.warn(
      `[SkillIntelligenceAgent] ${name} unavailable`,
      {
        error: err instanceof Error
          ? err.message
          : 'Unknown require error',
      }
    );
    return null;
  }
}

module.exports = SkillIntelligenceAgent;