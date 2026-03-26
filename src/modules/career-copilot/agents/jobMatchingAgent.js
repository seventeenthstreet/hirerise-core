'use strict';

/**
 * jobMatchingAgent.js — Job Matching Agent
 *
 * Uses: Job Matching Engine + Semantic Job Matching Engine
 *
 * Calls (read-only, never modified):
 *   jobMatchingEngine.getJobMatches(userId, { limit, minScore })
 *     → recommended_jobs[], total_roles_evaluated, user_skills_count
 *   jobMatchingEngine.getRecommendations(userId)
 *     → enriched top-5 with summary
 *   semanticJobMatching.getSemanticJobRecommendations(profile, candidates, opts)
 *     → semantic vector-scored matches (when FEATURE_SEMANTIC_MATCHING=true)
 *
 * Output:
 *   recommended_jobs   — top matched roles with scores and missing skills
 *   top_match          — the single best match (for advisor prompt)
 *   total_evaluated    — total roles evaluated by the engine
 *   scoring_mode       — 'semantic' | 'keyword'
 *   summary            — human-readable match summary
 *
 * File location: src/modules/career-copilot/agents/jobMatchingAgent.js
 *
 * @module src/modules/career-copilot/agents/jobMatchingAgent
 */

const BaseAgent = require('./baseAgent');
const logger    = require('../../../utils/logger');

class JobMatchingAgent extends BaseAgent {

  get agentName()   { return 'JobMatchingAgent'; }
  get cachePrefix() { return 'agent:jobs'; }

  async run(userId, context) {
    const jobMatchSvc = this._require(
      '../../../modules/jobSeeker/jobMatchingEngine.service',
      'JobMatchingEngine'
    );
    if (!jobMatchSvc) throw new Error('JobMatchingEngine unavailable');

    let result      = null;
    let scoringMode = 'keyword';

    // ── Semantic matching (feature-flagged) ───────────────────────────────────
    if (process.env.FEATURE_SEMANTIC_MATCHING === 'true') {
      try {
        const semanticSvc    = this._require('../../../engines/semanticJobMatching.engine', 'SemanticJobMatchingEngine');
        const skillGraphSvc  = this._require('../../../modules/jobSeeker/skillGraphEngine.service', 'SkillGraphEngine');

        if (semanticSvc && skillGraphSvc) {
          // Get skill graph to build user vector profile
          const graph = await skillGraphSvc.getUserSkillGraph(userId).catch(() => null);

          // Get a wider candidate set for semantic ranking
          const rawMatches = await jobMatchSvc.getJobMatches(userId, { limit: 50, minScore: 0 });
          const candidates  = (rawMatches?.recommended_jobs || []).map(j => ({
            id:            j.id    || j.roleId || j.title,
            title:         j.title,
            description:   j.description || '',
            skills:        j.role_specific_skills || j.missing_skills || [],
            company:       j.company  || null,
            location:      j.location || null,
            yearsRequired: j.yearsRequired || 0,
            industry:      j.sector   || j.industry || null,
          }));

          const userProfile = {
            userId,
            skills:          graph?.existing_skills  || [],
            yearsExperience: context?.years_experience || 0,
            industry:        graph?.industry          || context?.industry || '',
          };

          const semanticResult = await semanticSvc.getSemanticJobRecommendations(
            userProfile, candidates, { topN: 10, minScore: 30 }
          );

          if (semanticResult?.recommended_jobs?.length > 0) {
            result      = semanticResult;
            scoringMode = 'semantic';
          }
        }
      } catch (err) {
        logger.warn('[JobMatchingAgent] Semantic fallback to keyword matching', { userId, err: err.message });
      }
    }

    // ── Keyword matching (primary or fallback) ────────────────────────────────
    if (!result) {
      result = await jobMatchSvc.getJobMatches(userId, { limit: 10, minScore: 20 });
    }

    // Normalise jobs array
    const jobs = (result?.recommended_jobs || []).slice(0, 10).map(j => ({
      title:          j.title,
      company:        j.company        || null,
      sector:         j.sector         || j.industry || null,
      match_score:    Math.round(j.match_score    || j.score || 0),
      semantic_score: j.semantic_score !== undefined ? Math.round(j.semantic_score) : null,
      missing_skills: (j.missing_skills || []).slice(0, 5),
      salary:         j.salary         || null,
      description:    j.description    || null,
    }));

    const topMatch = jobs[0] || null;

    return {
      recommended_jobs:  jobs,
      top_match:         topMatch,
      total_evaluated:   result?.total_roles_evaluated || 0,
      user_skills_count: result?.user_skills_count     || 0,
      scoring_mode:      scoringMode,
      summary:           topMatch
        ? `Your top match is "${topMatch.title}" with a ${topMatch.match_score}% fit score.`
        : 'No strong role matches found yet. Add more skills to your profile.',
    };
  }

  _require(path, name) {
    try { return require(path); }
    catch (err) {
      logger.warn(`[JobMatchingAgent] ${name} unavailable`, { err: err.message });
      return null;
    }
  }
}

module.exports = JobMatchingAgent;









