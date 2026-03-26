'use strict';

/**
 * intelligenceOrchestrator.js — Unified Career Intelligence Engine
 *
 * Runs all four engines in parallel and merges them into a single
 * combined intelligence result for the HireRise dashboard and AI advisor.
 *
 * Engines orchestrated:
 *   1. CHI v2              — career readiness score (0–100)
 *   2. Skill Gap           — missing skills + learning path
 *   3. Career Path         — BFS progression path + timeline
 *   4. Career Opportunity  — labor market demand + ranked opportunities
 *   5. Learning            — course recommendations for each skill gap
 *
 * SECURITY: Read-only Firestore. No writes. No auth mutations. No secrets.
 */

const { calculateCHI, resolveRoleId }         = require('./chiV2.engine');
const { analyseSkillGap }                      = require('./skillGapEngine');
const { recommendCareerPath }                  = require('./careerPathEngine');
const { analyseCareerOpportunities }           = require('./careerOpportunityEngine');
const { recommendLearning }                    = require('../../engines/learning.engine');
const logger                                   = require('../../utils/logger');

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runIntelligence(profile, options = {}) {
  const {
    current_role,
    target_role,
    skills         = [],
    skill_levels   = [],
    education_level,
    years_experience = 0,
    current_salary   = 0,
  } = profile;

  if (!target_role) throw new Error('target_role is required');

  const start = Date.now();

  // Resolve role IDs once — reused by all four engines
  const [targetRoleId, currentRoleId] = await Promise.all([
    resolveRoleId(target_role),
    current_role ? resolveRoleId(current_role) : Promise.resolve(null),
  ]);

  if (!targetRoleId) throw new Error(`Target role not found in graph: "${target_role}"`);

  logger.info('[Intelligence] Starting parallel engine run', {
    currentRoleId, targetRoleId, skill_count: skills.length,
  });

  // Run all four engines in parallel — each failure is caught independently
  const [chiResult, skillGapResult, careerPathResult, opportunityResult] = await Promise.all([

    calculateCHI({ current_role, target_role, skills, skill_levels,
      education_level, years_experience, current_salary })
      .catch(err => { logger.error('[Intelligence] CHI failed', { err: err.message }); return null; }),

    analyseSkillGap(targetRoleId, skills)
      .catch(err => { logger.error('[Intelligence] SkillGap failed', { err: err.message }); return null; }),

    recommendCareerPath(currentRoleId, targetRoleId)
      .catch(err => { logger.error('[Intelligence] CareerPath failed', { err: err.message }); return null; }),

    (currentRoleId
      ? analyseCareerOpportunities(
          { current_role_id: currentRoleId, chi_score: null }, // chi_score patched in below
          { country: options.country, top_n: options.top_n }
        )
      : Promise.resolve(null)
    ).catch(err => { logger.error('[Intelligence] Opportunity failed', { err: err.message }); return null; }),
  ]);

  // Patch chi_score into opportunity results now that CHI is resolved
  let patchedOpportunity = opportunityResult;
  if (opportunityResult && chiResult?.chi_score != null) {
    const chi = chiResult.chi_score;
    patchedOpportunity = {
      ...opportunityResult,
      career_opportunities: opportunityResult.career_opportunities.map(opp => ({
        ...opp,
        opportunity_score: Math.round(chi * 0.60 + opp.market_demand_score * 0.40),
      })),
      meta: { ...opportunityResult.meta, chi_score_used: chi },
    };
    // Re-sort after patching
    patchedOpportunity.career_opportunities.sort(
      (a, b) => b.opportunity_score - a.opportunity_score
    );
  }

  // ── Learning recommendations (runs after skillGap — needs gap list) ────────
  // Derive skill gap names from skillGapResult (all priorities combined)
  const allGaps = skillGapResult
    ? [
        ...(skillGapResult.high_priority   ?? []),
        ...(skillGapResult.medium_priority ?? []),
        ...(skillGapResult.low_priority    ?? []),
      ]
    : [];

  const learningResult = allGaps.length > 0
    ? await recommendLearning(
        { role: current_role ?? null, target_role, skills },
        allGaps
      ).catch(err => {
        logger.error('[Intelligence] Learning failed', { err: err.message });
        return null;
      })
    : null;

  logger.info('[Intelligence] All engines complete', { elapsed_ms: Date.now() - start });

  return buildOutput({
    chiResult,
    skillGapResult,
    careerPathResult,
    opportunityResult: patchedOpportunity,
    learningResult,
    targetRoleId,
    currentRoleId,
  });
}

// ─── Output Builder ───────────────────────────────────────────────────────────

function buildOutput({ chiResult, skillGapResult, careerPathResult, opportunityResult, learningResult, targetRoleId, currentRoleId }) {

  // CHI
  const chi_score  = chiResult?.chi_score  ?? null;
  const breakdown  = chiResult?.breakdown  ?? null;
  const chi_meta   = chiResult?.meta       ?? null;

  // Skill Gap
  const skillGap = skillGapResult ? {
    high_priority:      skillGapResult.high_priority,
    medium_priority:    skillGapResult.medium_priority,
    low_priority:       skillGapResult.low_priority,
    matched_skills:     skillGapResult.matched_skills,
    skill_coverage_pct: skillGapResult.skill_coverage_pct,
    total_required:     skillGapResult.total_required,
    total_missing:      skillGapResult.total_missing,
    total_matched:      skillGapResult.total_matched,
  } : null;

  const learning_path = skillGapResult?.learning_path ?? null;

  // Career Path
  const careerPath = careerPathResult ? {
    found:           careerPathResult.found,
    career_path:     careerPathResult.career_path,
    role_names:      careerPathResult.role_names,
    steps:           careerPathResult.steps,
    estimated_years: careerPathResult.estimated_years,
    alternate_paths: careerPathResult.alternate_paths,
    message:         careerPathResult.message,
  } : null;

  const next_role         = careerPathResult?.next_role        ?? null;
  const next_role_skills  = careerPathResult?.next_role_skills ?? [];

  // Opportunities
  const career_opportunities = opportunityResult?.career_opportunities ?? [];

  // Unified insights — merge all engines, deduplicate
  const insights = [
    ...(chiResult?.insights ?? []),
    ...buildCareerPathInsights(careerPathResult),
    ...buildSkillGapInsights(skillGapResult),
    ...(opportunityResult?.insights ?? []),
  ];

  // Flat skill gap lists
  const flatSkillGap = {
    high_priority:   skillGapResult?.high_priority.map(s => s.skill_name)   ?? [],
    medium_priority: skillGapResult?.medium_priority.map(s => s.skill_name) ?? [],
    low_priority:    skillGapResult?.low_priority.map(s => s.skill_name)    ?? [],
  };

  return {
    // Score
    chi_score,
    chi_breakdown: breakdown,

    // Skill gap
    skill_gap:        flatSkillGap,
    skill_gap_detail: skillGap,

    // Learning path
    learning_path:        skillGapResult?.learning_path?.steps.map(s => s.skill_name) ?? [],
    learning_path_detail: learning_path,

    // Career path
    career_path:        careerPathResult?.role_names ?? [],
    career_path_detail: careerPath,

    // Timeline & next role
    estimated_years:         careerPathResult?.estimated_years ?? null,
    next_role:               next_role?.role_name ?? null,
    next_role_detail:        next_role,
    next_role_skills:        next_role_skills.map(s => s.skill_name),
    next_role_skills_detail: next_role_skills,

    // Opportunities
    career_opportunities,
    opportunity_meta: opportunityResult?.meta ?? null,

    // Learning recommendations (course suggestions per skill gap)
    learning_recommendations:        learningResult?.learning_recommendations ?? [],
    learning_recommendations_summary: learningResult?.summary                 ?? null,

    // Insights
    insights: [...new Set(insights)],

    // Engine metadata
    meta: {
      target_role_id:  targetRoleId,
      current_role_id: currentRoleId ?? null,
      engines_run:     ['chi_v2', 'skill_gap', 'career_path', 'opportunity', 'learning'],
      chi_meta,
      calculated_at:   new Date().toISOString(),
    },
  };
}

// ─── Supplemental Insight Generators ─────────────────────────────────────────

function buildCareerPathInsights(result) {
  if (!result) return [];
  const insights = [];
  if (result.found && result.alternate_paths?.length > 0) {
    insights.push(`${result.alternate_paths.length} alternate career path${result.alternate_paths.length > 1 ? 's' : ''} available`);
  }
  if (result.next_role) {
    insights.push(`Your immediate next step is: ${result.next_role.role_name}`);
  }
  return insights;
}

function buildSkillGapInsights(result) {
  if (!result) return [];
  const insights = [];
  const highCount = result.high_priority?.length ?? 0;
  if (highCount > 0) {
    const names = result.high_priority.slice(0, 2).map(s => s.skill_name).join(', ');
    insights.push(`${highCount} high-priority skill gap${highCount > 1 ? 's' : ''} detected: ${names}`);
  }
  if (result.learning_path?.estimated_months > 0) {
    insights.push(`Estimated learning time to close skill gaps: ${result.learning_path.estimated_months} month${result.learning_path.estimated_months !== 1 ? 's' : ''}`);
  }
  if (result.skill_coverage_pct >= 80) {
    insights.push('Your skill coverage is strong — focus on deepening proficiency');
  }
  return insights;
}

module.exports = { runIntelligence };








