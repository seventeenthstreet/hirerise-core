'use strict';

/**
 * skillIntelligenceAgent.js — Skill Intelligence Agent
 *
 * Uses: Skill Graph Engine + Semantic Skill Intelligence
 *
 * Calls (read-only, never modified):
 *   skillGraphEngine.getUserSkillGraph(userId)   → existing_skills, adjacent_skills, next_level_skills
 *   skillGraphEngine.detectSkillGap(userId)      → missing_high_demand, role_gap, learning_paths
 *   semanticSkill.findSimilarSkills(skill)       → semantic neighbours for top gaps (if enabled)
 *
 * Output:
 *   existing_skills     — user's current skills
 *   missing_high_demand — high-demand skills user lacks (with demand_score)
 *   adjacent_skills     — learnable next skills from graph traversal
 *   next_level_skills   — advanced skills beyond current level
 *   role_gap            — { target_role, match_percentage, missing_required[] }
 *   learning_paths      — [{ skill, path[] }] for top 3 missing skills
 *   recommended_skills  — prioritised list for the advisor prompt
 *
 * File location: src/modules/career-copilot/agents/skillIntelligenceAgent.js
 *
 * @module src/modules/career-copilot/agents/skillIntelligenceAgent
 */

const BaseAgent = require('./baseAgent');
const logger    = require('../../../utils/logger');

class SkillIntelligenceAgent extends BaseAgent {

  get agentName()   { return 'SkillIntelligenceAgent'; }
  get cachePrefix() { return 'agent:skill'; }

  async run(userId, context) {
    // ── Load engines ──────────────────────────────────────────────────────────
    const skillGraphSvc = this._loadEngine(
      '../../../modules/jobSeeker/skillGraphEngine.service',
      'SkillGraphEngine'
    );
    // Both getUserSkillGraph and detectSkillGap come from the same service
    if (!skillGraphSvc) throw new Error('SkillGraphEngine unavailable');

    // ── Run graph + gap in parallel ───────────────────────────────────────────
    const [graphRes, gapRes] = await Promise.allSettled([
      skillGraphSvc.getUserSkillGraph(userId),
      skillGraphSvc.detectSkillGap(userId),
    ]);

    const graph = graphRes.status === 'fulfilled' ? graphRes.value : null;
    const gap   = gapRes.status   === 'fulfilled' ? gapRes.value   : null;

    if (graphRes.status === 'rejected') {
      logger.warn('[SkillIntelligenceAgent] getUserSkillGraph failed', {
        userId, err: graphRes.reason?.message,
      });
    }
    if (gapRes.status === 'rejected') {
      logger.warn('[SkillIntelligenceAgent] detectSkillGap failed', {
        userId, err: gapRes.reason?.message,
      });
    }

    // ── Optional: semantic enrichment for top missing skills ──────────────────
    let semanticNeighbours = [];
    if (
      process.env.FEATURE_SEMANTIC_MATCHING === 'true' &&
      (gap?.missing_high_demand || []).length > 0
    ) {
      const semanticSvc = this._loadEngine(
        '../../../engines/semanticSkill.engine',
        'SemanticSkillEngine'
      );
      if (semanticSvc) {
        const topMissing = (gap.missing_high_demand || []).slice(0, 3)
          .map(s => (typeof s === 'string' ? s : s?.name))
          .filter(Boolean);

        const semResults = await Promise.allSettled(
          topMissing.map(name =>
            semanticSvc.findSimilarSkills(name, { topK: 3, minScore: 0.7 })
          )
        );

        for (const r of semResults) {
          if (r.status === 'fulfilled' && r.value?.length) {
            semanticNeighbours.push(...r.value.map(s => s.skill_name || s.name).filter(Boolean));
          }
        }
        // Deduplicate
        semanticNeighbours = [...new Set(semanticNeighbours)].slice(0, 6);
      }
    }

    // ── Normalise and return ──────────────────────────────────────────────────
    const missingHighDemand = (gap?.missing_high_demand || []).slice(0, 8).map(s =>
      typeof s === 'string'
        ? { name: s, demand_score: null, category: null }
        : { name: s.name, demand_score: s.demand_score || null, category: s.category || null }
    );

    // Combine missing + semantic neighbours into a prioritised recommendations list
    const recommended = [
      ...missingHighDemand.map(s => s.name),
      ...semanticNeighbours.filter(n => !missingHighDemand.find(m => m.name === n)),
    ].filter(Boolean).slice(0, 10);

    return {
      existing_skills:     graph?.existing_skills     || [],
      adjacent_skills:     graph?.adjacent_skills     || [],
      next_level_skills:   graph?.next_level_skills   || [],
      role_specific_skills: graph?.role_specific_skills || [],
      missing_high_demand: missingHighDemand,
      role_gap:            gap?.role_gap              || null,
      learning_paths:      (gap?.learning_paths       || []).slice(0, 3),
      semantic_neighbours: semanticNeighbours,
      recommended_skills:  recommended,
      target_role:         graph?.target_role         || gap?.target_role || null,
      industry:            graph?.industry            || null,
      skill_count:         graph?.skill_count         || 0,
    };
  }

  _loadEngine(path, name) {
    try {
      return require(path);
    } catch (err) {
      logger.warn(`[SkillIntelligenceAgent] ${name} not available`, { err: err.message });
      return null;
    }
  }
}

module.exports = SkillIntelligenceAgent;









