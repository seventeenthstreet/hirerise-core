'use strict';

/**
 * intelligenceOrchestrator.js
 *
 * Unified CHI v2 orchestration layer
 * - fully Supabase-compatible
 * - parallel fault-isolated engine execution
 * - no duplicate scoring recomputation
 */

const { calculateCHI, resolveRoleId } = require('./chiV2.engine');
const { analyseSkillGap } = require('./skillGapEngine');
const { recommendCareerPath } = require('./careerPathEngine');
const { analyseCareerOpportunities } = require('./careerOpportunityEngine');
const { recommendLearning } = require('../../engines/learning.engine');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function runIntelligence(profile, options = {}) {
  const {
    current_role,
    target_role,
    skills = [],
    skill_levels = [],
    education_level,
    years_experience = 0,
    current_salary = 0
  } = profile;

  if (!target_role) {
    throw new Error('target_role is required');
  }

  const start = Date.now();

  const [targetRoleId, currentRoleId] = await Promise.all([
    resolveRoleId(target_role),
    current_role
      ? resolveRoleId(current_role)
      : Promise.resolve(null)
  ]);

  if (!targetRoleId) {
    throw new Error(`Target role not found in graph: "${target_role}"`);
  }

  logger.info('[Intelligence] Starting unified run', {
    current_role_id: currentRoleId,
    target_role_id: targetRoleId,
    skill_count: skills.length
  });

  const chiInput = {
    current_role,
    target_role,
    skills,
    skill_levels,
    education_level,
    years_experience,
    current_salary
  };

  const settled = await Promise.allSettled([
    calculateCHI(chiInput),
    analyseSkillGap(targetRoleId, skills),
    recommendCareerPath(currentRoleId, targetRoleId),
    currentRoleId
      ? analyseCareerOpportunities(
          {
            current_role_id: currentRoleId,
            chi_score: null // patched after CHI
          },
          {
            country: options.country,
            top_n: options.top_n
          }
        )
      : Promise.resolve(null)
  ]);

  const [
    chiResult,
    skillGapResult,
    careerPathResult,
    opportunityBase
  ] = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;

    const names = [
      'CHI',
      'SkillGap',
      'CareerPath',
      'Opportunity'
    ];

    logger.error(`[Intelligence] ${names[index]} failed`, {
      error: result.reason?.message
    });

    return null;
  });

  const opportunityResult =
    opportunityBase && chiResult?.chi_score != null
      ? patchOpportunityScores(
          opportunityBase,
          chiResult.chi_score
        )
      : opportunityBase;

  const allGaps = extractAllSkillGaps(skillGapResult);

  const learningResult =
    allGaps.length > 0
      ? await recommendLearning(
          {
            role: current_role ?? null,
            target_role,
            skills
          },
          allGaps
        ).catch(error => {
          logger.warn('[Intelligence] Learning degraded', {
            error: error.message
          });
          return null;
        })
      : null;

  logger.info('[Intelligence] Unified run complete', {
    elapsed_ms: Date.now() - start
  });

  return buildOutput({
    chiResult,
    skillGapResult,
    careerPathResult,
    opportunityResult,
    learningResult,
    targetRoleId,
    currentRoleId
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractAllSkillGaps(skillGapResult) {
  if (!skillGapResult) return [];

  return [
    ...(skillGapResult.high_priority ?? []),
    ...(skillGapResult.medium_priority ?? []),
    ...(skillGapResult.low_priority ?? [])
  ];
}

function patchOpportunityScores(result, chiScore) {
  const patched = {
    ...result,
    career_opportunities: [...(result.career_opportunities || [])]
      .map(opp => ({
        ...opp,
        opportunity_score: Math.round(
          chiScore * 0.6 + opp.market_demand_score * 0.4
        )
      }))
      .sort((a, b) => b.opportunity_score - a.opportunity_score),
    meta: {
      ...result.meta,
      chi_score_used: chiScore
    }
  };

  return patched;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Builder
// ─────────────────────────────────────────────────────────────────────────────

function buildOutput({
  chiResult,
  skillGapResult,
  careerPathResult,
  opportunityResult,
  learningResult,
  targetRoleId,
  currentRoleId
}) {
  const insights = [
    ...(chiResult?.insights ?? []),
    ...buildCareerPathInsights(careerPathResult),
    ...buildSkillGapInsights(skillGapResult),
    ...(opportunityResult?.insights ?? [])
  ];

  return {
    chi_score: chiResult?.chi_score ?? null,
    chi_breakdown: chiResult?.breakdown ?? null,

    skill_gap: {
      high_priority:
        skillGapResult?.high_priority?.map(s => s.skill_name) ?? [],
      medium_priority:
        skillGapResult?.medium_priority?.map(s => s.skill_name) ?? [],
      low_priority:
        skillGapResult?.low_priority?.map(s => s.skill_name) ?? []
    },

    skill_gap_detail: skillGapResult
      ? {
          high_priority: skillGapResult.high_priority,
          medium_priority: skillGapResult.medium_priority,
          low_priority: skillGapResult.low_priority,
          matched_skills: skillGapResult.matched_skills,
          skill_coverage_pct: skillGapResult.skill_coverage_pct,
          total_required: skillGapResult.total_required,
          total_missing: skillGapResult.total_missing,
          total_matched: skillGapResult.total_matched
        }
      : null,

    learning_path:
      skillGapResult?.learning_path?.steps?.map(
        step => step.skill_name
      ) ?? [],

    learning_path_detail:
      skillGapResult?.learning_path ?? null,

    career_path:
      careerPathResult?.career_path?.map(
        step => step.role_name
      ) ?? [],

    career_path_detail: careerPathResult ?? null,

    estimated_years:
      careerPathResult?.estimated_years ?? null,

    next_role:
      careerPathResult?.next_role?.role_name ?? null,

    next_role_detail:
      careerPathResult?.next_role ?? null,

    next_role_skills:
      careerPathResult?.next_role_skills?.map(
        skill => skill.skill_name
      ) ?? [],

    next_role_skills_detail:
      careerPathResult?.next_role_skills ?? [],

    career_opportunities:
      opportunityResult?.career_opportunities ?? [],

    opportunity_meta:
      opportunityResult?.meta ?? null,

    learning_recommendations:
      learningResult?.learning_recommendations ?? [],

    learning_recommendations_summary:
      learningResult?.summary ?? null,

    insights: [...new Set(insights)],

    meta: {
      target_role_id: targetRoleId,
      current_role_id: currentRoleId ?? null,
      engines_run: [
        'chi_v2',
        'skill_gap',
        'career_path',
        'opportunity',
        'learning'
      ],
      chi_meta: chiResult?.meta ?? null,
      calculated_at: new Date().toISOString()
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Insight Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildCareerPathInsights(result) {
  if (!result) return [];

  const insights = [];

  if (result.found && result.alternate_paths?.length > 0) {
    insights.push(
      `${result.alternate_paths.length} alternate career path${
        result.alternate_paths.length > 1 ? 's' : ''
      } available`
    );
  }

  if (result.next_role) {
    insights.push(
      `Your immediate next step is: ${result.next_role.role_name}`
    );
  }

  return insights;
}

function buildSkillGapInsights(result) {
  if (!result) return [];

  const insights = [];
  const highCount = result.high_priority?.length ?? 0;

  if (highCount > 0) {
    const names = result.high_priority
      .slice(0, 2)
      .map(skill => skill.skill_name)
      .join(', ');

    insights.push(
      `${highCount} high-priority skill gap${
        highCount > 1 ? 's' : ''
      } detected: ${names}`
    );
  }

  if (result.learning_path?.estimated_months > 0) {
    insights.push(
      `Estimated learning time to close skill gaps: ${result.learning_path.estimated_months} month${
        result.learning_path.estimated_months !== 1 ? 's' : ''
      }`
    );
  }

  if (result.skill_coverage_pct >= 80) {
    insights.push(
      'Your skill coverage is strong — focus on deepening proficiency'
    );
  }

  return insights;
}

module.exports = {
  runIntelligence
};