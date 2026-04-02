'use strict';

/**
 * src/modules/career-copilot/agents/jobMatchingAgent.js
 *
 * Job matching orchestration agent.
 * Supports:
 * - keyword matching (primary)
 * - semantic ranking (feature-flagged)
 * - safe fallback behavior
 */

const BaseAgent = require('./baseAgent');
const logger = require('../../../utils/logger');

const jobMatchingEngine = safeRequire(
  '../../../modules/jobSeeker/jobMatchingEngine.service',
  'JobMatchingEngine'
);

const semanticJobMatchingEngine = safeRequire(
  '../../../engines/semanticJobMatching.engine',
  'SemanticJobMatchingEngine'
);

const skillGraphEngine = safeRequire(
  '../../../modules/jobSeeker/skillGraphEngine.service',
  'SkillGraphEngine'
);

class JobMatchingAgent extends BaseAgent {
  get agentName() {
    return 'JobMatchingAgent';
  }

  get cachePrefix() {
    return 'agent:jobs';
  }

  /**
   * @param {string} userId
   * @param {object} context
   * @returns {Promise<object>}
   */
  async run(userId, context = {}) {
    if (!jobMatchingEngine?.getJobMatches) {
      throw new Error('JobMatchingEngine unavailable');
    }

    let result = null;
    let scoringMode = 'keyword';

    const semanticEnabled =
      String(process.env.FEATURE_SEMANTIC_MATCHING).toLowerCase() === 'true';

    // ──────────────────────────────────────────────────────────────────────────
    // Semantic matching (feature-flagged)
    // ──────────────────────────────────────────────────────────────────────────
    if (
      semanticEnabled &&
      semanticJobMatchingEngine?.getSemanticJobRecommendations &&
      skillGraphEngine?.getUserSkillGraph
    ) {
      try {
        result = await this._runSemanticMatching(
          userId,
          context
        );

        if (result?.recommended_jobs?.length) {
          scoringMode = 'semantic';
        } else {
          result = null;
        }
      } catch (err) {
        logger.warn('[JobMatchingAgent] Semantic fallback to keyword matching', {
          userId,
          error: err instanceof Error ? err.message : 'Unknown semantic error',
        });

        result = null;
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Keyword matching
    // ──────────────────────────────────────────────────────────────────────────
    if (!result) {
      result = await jobMatchingEngine.getJobMatches(userId, {
        limit: 10,
        minScore: 20,
      });
    }

    const jobs = this._normalizeJobs(result?.recommended_jobs);
    const topMatch = jobs[0] || null;

    return {
      recommended_jobs: jobs,
      top_match: topMatch,
      total_evaluated: Number(result?.total_roles_evaluated || 0),
      user_skills_count: Number(result?.user_skills_count || 0),
      scoring_mode: scoringMode,
      summary: topMatch
        ? `Your top match is "${topMatch.title}" with a ${topMatch.match_score}% fit score.`
        : 'No strong role matches found yet. Add more skills to your profile.',
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Internal semantic flow
  // ────────────────────────────────────────────────────────────────────────────

  async _runSemanticMatching(userId, context = {}) {
    const graph = await skillGraphEngine
      .getUserSkillGraph(userId)
      .catch(() => null);

    const rawMatches = await jobMatchingEngine.getJobMatches(userId, {
      limit: 50,
      minScore: 0,
    });

    const candidates = (rawMatches?.recommended_jobs || [])
      .map((job) => this._mapCandidate(job))
      .filter(Boolean);

    if (!candidates.length) {
      return null;
    }

    const userProfile = {
      userId,
      skills: Array.isArray(graph?.existing_skills)
        ? graph.existing_skills
        : [],
      yearsExperience: Number(
        context?.years_experience ??
          context?.yearsExperience ??
          0
      ),
      industry:
        graph?.industry ||
        context?.industry ||
        '',
    };

    return semanticJobMatchingEngine.getSemanticJobRecommendations(
      userProfile,
      candidates,
      {
        topN: 10,
        minScore: 30,
      }
    );
  }

  _mapCandidate(job) {
    if (!job?.title) return null;

    return {
      id: job.id || job.roleId || job.title,
      title: job.title,
      description: job.description || '',
      skills: Array.isArray(job.role_specific_skills)
        ? job.role_specific_skills
        : Array.isArray(job.missing_skills)
          ? job.missing_skills
          : [],
      company: job.company || null,
      location: job.location || null,
      yearsRequired: Number(job.yearsRequired || 0),
      industry: job.sector || job.industry || null,
    };
  }

  _normalizeJobs(recommendedJobs = []) {
    return (Array.isArray(recommendedJobs) ? recommendedJobs : [])
      .slice(0, 10)
      .map((job) => ({
        title: job?.title || null,
        company: job?.company || null,
        sector: job?.sector || job?.industry || null,
        match_score: this._safeScore(job?.match_score ?? job?.score),
        semantic_score:
          job?.semantic_score != null
            ? this._safeScore(job.semantic_score)
            : null,
        missing_skills: Array.isArray(job?.missing_skills)
          ? job.missing_skills.slice(0, 5)
          : [],
        salary: job?.salary || null,
        description: job?.description || null,
      }))
      .filter((job) => job.title);
  }

  _safeScore(value) {
    const numeric = Number(value || 0);
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }
}

/**
 * Safe cold-start module resolution.
 * Done once at module load instead of every request.
 */
function safeRequire(path, name) {
  try {
    return require(path);
  } catch (err) {
    logger.warn(`[JobMatchingAgent] ${name} unavailable`, {
      error: err instanceof Error ? err.message : 'Unknown require error',
    });
    return null;
  }
}

module.exports = JobMatchingAgent;