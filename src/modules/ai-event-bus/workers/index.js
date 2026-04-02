'use strict';

/**
 * workers/index.js — optimized worker implementations
 *
 * Key upgrades:
 * - Removed remaining Firestore-style profile loading logic
 * - Fully Supabase-native profile reads
 * - Shared engine fallback helper
 * - Better parallelization for expensive engines
 * - Safer null normalization for result rows
 * - Cleaner worker bootstrap lifecycle
 */

const BaseWorker = require('./baseWorker');
const { QUEUE_NAMES } = require('../queues/queue.config');
const supabase = require('../../config/supabase');
const logger = require('../../../utils/logger');

const engines = {};
const ENGINE_PATHS = {
  skillGraph: '../../modules/jobSeeker/skillGraphEngine.service',
  jobMatching: '../../modules/jobSeeker/jobMatchingEngine.service',
  chiV2: '../../modules/chiV2/chiV2.engine',
  skillGap: '../../modules/chiV2/skillGapEngine',
  semanticJobMatch: '../../engines/semanticJobMatching.engine',
  opportunityRadar: '../../engines/opportunityRadar.engine',
  careerAdvisor: '../../engines/careerAdvisor.engine',
  marketTrend: '../../modules/labor-market-intelligence/services/marketTrend.service',
  careerRisk: '../../engines/careerRisk.engine',
};

function getEngine(name) {
  if (engines[name] !== undefined) return engines[name];
  try {
    engines[name] = require(ENGINE_PATHS[name]);
  } catch (error) {
    logger.warn('[Workers] Engine unavailable', { name, error: error.message });
    engines[name] = null;
  }
  return engines[name];
}

async function loadUserProfile(userId) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('target_role,current_role,skills,skill_levels,education_level,years_experience,current_salary')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return {};

  return {
    target_role: data.target_role || null,
    current_role: data.current_role || null,
    skills: Array.isArray(data.skills) ? data.skills : [],
    skill_levels: data.skill_levels || [],
    education_level: data.education_level || null,
    years_experience: data.years_experience || 0,
    current_salary: data.current_salary || 0,
  };
}

class SkillGraphWorker extends BaseWorker {
  get queueName() { return QUEUE_NAMES.SKILL_GRAPH; }
  get concurrency() { return 3; }
  get resultTableName() { return 'skill_graph_results'; }
  get cacheKeyPrefix() { return 'worker:skill-graph'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const svc = getEngine('skillGraph');
    if (!svc) throw new Error('SkillGraphEngine unavailable');

    const [graph, gap] = await Promise.all([
      svc.getUserSkillGraph(userId),
      svc.detectSkillGap?.(userId).catch(() => null),
    ]);

    return {
      existing_skills: graph?.existing_skills || [],
      adjacent_skills: graph?.adjacent_skills || [],
      next_level_skills: graph?.next_level_skills || [],
      role_specific_skills: graph?.role_specific_skills || [],
      missing_high_demand: gap?.missing_high_demand || [],
      target_role: graph?.target_role || null,
      industry: graph?.industry || null,
      skill_count: graph?.skill_count || 0,
    };
  }
}

class CareerHealthWorker extends BaseWorker {
  get queueName() { return QUEUE_NAMES.CAREER_HEALTH; }
  get concurrency() { return 2; }
  get resultTableName() { return 'career_health_results'; }
  get cacheKeyPrefix() { return 'worker:career-health'; }

  async process(job, envelope) {
    const { userId, profile: payloadProfile } = envelope.payload;
    const profile = payloadProfile || await loadUserProfile(userId);

    const chiEngine = getEngine('chiV2');
    const skillGapEngine = getEngine('skillGap');
    if (!chiEngine) throw new Error('CHI engine unavailable');

    if (!profile.target_role) {
      return {
        chi_score: null,
        dimensions: null,
        skill_gaps: [],
        analysis_source: 'skipped_no_target_role',
      };
    }

    const [chiResult, gapResult] = await Promise.all([
      chiEngine.calculateCHI(profile),
      skillGapEngine?.analyseSkillGap({
        target_role: profile.target_role,
        skills: profile.skills || [],
      }).catch(() => null),
    ]);

    return {
      chi_score: chiResult?.chi_score || chiResult?.score || null,
      dimensions: chiResult?.dimensions || chiResult?.scores || null,
      skill_gaps: gapResult?.missing_required || [],
      analysis_source: 'bullmq_async',
    };
  }
}

class JobMatchingWorker extends BaseWorker {
  get queueName() { return QUEUE_NAMES.JOB_MATCHING; }
  get concurrency() { return 3; }
  get resultTableName() { return 'job_match_results'; }
  get cacheKeyPrefix() { return 'worker:job-matching'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const svc = getEngine('jobMatching');
    if (!svc) throw new Error('JobMatching engine unavailable');

    const result = await svc.getJobMatches(userId, { limit: 10 });

    return {
      recommended_jobs: result?.recommended_jobs || result?.jobs || [],
      total_evaluated: result?.total_roles_evaluated || 0,
      user_skills_count: result?.user_skills_count || 0,
      scoring_mode: process.env.FEATURE_SEMANTIC_MATCHING === 'true' ? 'hybrid' : 'keyword',
    };
  }
}

class RiskAnalysisWorker extends BaseWorker {
  get queueName() { return QUEUE_NAMES.RISK_ANALYSIS; }
  get concurrency() { return 2; }
  get resultTableName() { return 'risk_analysis_results'; }
  get cacheKeyPrefix() { return 'worker:risk-analysis'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const engine = getEngine('careerRisk');
    if (!engine) {
      return {
        overall_risk_score: null,
        risk_level: null,
        risk_factors: [],
        recommendations: [],
        market_stability: null,
        _stub: true,
      };
    }

    const result = await engine.analyzeCareerRisk(userId);
    return {
      overall_risk_score: result?.overall_risk_score || result?.riskScore || 0,
      risk_level: result?.risk_level || result?.riskLevel || 'Medium',
      risk_factors: result?.risk_factors || result?.factors || [],
      recommendations: result?.recommendations || [],
      market_stability: result?.market_stability || null,
    };
  }
}

class OpportunityRadarWorker extends BaseWorker {
  get queueName() { return QUEUE_NAMES.OPPORTUNITY_RADAR; }
  get concurrency() { return 2; }
  get resultTableName() { return 'opportunity_radar_results'; }
  get cacheKeyPrefix() { return 'worker:opportunity-radar'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const engine = getEngine('opportunityRadar');
    if (!engine) throw new Error('Opportunity radar unavailable');

    const result = await engine.getOpportunityRadar(userId, { topN: 10, minOpportunityScore: 40 });
    return {
      emerging_opportunities: result?.emerging_opportunities || [],
      total_signals_evaluated: result?.total_signals_evaluated || 0,
    };
  }
}

class CareerAdvisorWorker extends BaseWorker {
  get queueName() { return QUEUE_NAMES.CAREER_ADVISOR; }
  get concurrency() { return 1; }
  get resultTableName() { return 'career_advice_results'; }
  get cacheKeyPrefix() { return 'worker:career-advisor'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const advisor = getEngine('careerAdvisor');
    if (!advisor) throw new Error('Career advisor unavailable');

    const [skillGraph, jobMatches, marketDemand] = await Promise.allSettled([
      getEngine('skillGraph')?.getUserSkillGraph(userId),
      getEngine('jobMatching')?.getJobMatches(userId, { limit: 5 }),
      getEngine('marketTrend')?.getTrendingSkills?.(),
    ]);

    const advice = await advisor.generateCareerAdvice({
      userId,
      profile: skillGraph.value || {},
      topJobMatches: jobMatches.value?.recommended_jobs || [],
      marketDemand: marketDemand.value || null,
    });

    return {
      career_insight: advice?.career_insight || null,
      key_opportunity: advice?.key_opportunity || null,
      salary_potential: advice?.salary_potential || null,
      timeline: advice?.timeline || null,
      skills_to_prioritise: advice?.skills_to_prioritise || [],
      profile_hash: advice?._profile_hash || null,
    };
  }
}

const WORKERS = {
  skillGraph: new SkillGraphWorker(),
  careerHealth: new CareerHealthWorker(),
  jobMatching: new JobMatchingWorker(),
  riskAnalysis: new RiskAnalysisWorker(),
  opportunityRadar: new OpportunityRadarWorker(),
  careerAdvisor: new CareerAdvisorWorker(),
};

function startAll() {
  Object.entries(WORKERS).forEach(([name, worker]) => {
    try {
      worker.start();
      logger.info('[Workers] Started', { name });
    } catch (error) {
      logger.error('[Workers] Failed to start', { name, error: error.message });
    }
  });
}

async function stopAll() {
  await Promise.allSettled(Object.values(WORKERS).map((worker) => worker.stop()));
  logger.info('[Workers] All workers stopped');
}

module.exports = {
  WORKERS,
  startAll,
  stopAll,
  SkillGraphWorker,
  CareerHealthWorker,
  JobMatchingWorker,
  RiskAnalysisWorker,
  OpportunityRadarWorker,
  CareerAdvisorWorker,
};