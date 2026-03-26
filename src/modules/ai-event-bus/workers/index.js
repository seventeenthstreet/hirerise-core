'use strict';

/**
 * workers/index.js — All AI Worker Implementations
 *
 * Five workers, each extending BaseWorker:
 *
 *   SkillGraphWorker       — runs SkillGraphEngine + detects skill gaps
 *   CareerHealthWorker     — runs CHI v2 engine
 *   JobMatchingWorker      — runs JobMatchingEngine (+ Semantic when enabled)
 *   RiskAnalysisWorker     — runs CareerRiskPredictorEngine
 *   OpportunityRadarWorker — runs OpportunityRadarEngine
 *   CareerAdvisorWorker    — runs CareerAdvisorEngine (Claude call)
 *
 * Each worker:
 *   1. Consumes its BullMQ queue
 *   2. Loads user profile from Firestore
 *   3. Runs its engine
 *   4. Persists result to dedicated Supabase table
 *   5. Caches result in Redis (10-minute TTL)
 *   6. Emits completion event via AIEventBus
 *
 * @module src/modules/ai-event-bus/workers/index
 */

const BaseWorker  = require('./baseWorker');
const { QUEUE_NAMES } = require('../queues/queue.config');
const logger       = require('../../utils/logger');

// ─── Lazy engine loaders ──────────────────────────────────────────────────────
// Use lazy loading to avoid circular deps and keep startup fast.

const _engines = {};

function getEngine(name) {
  if (_engines[name]) return _engines[name];
  const paths = {
    skillGraph:        '../../modules/jobSeeker/skillGraphEngine.service',
    jobMatching:       '../../modules/jobSeeker/jobMatchingEngine.service',
    chiV2:             '../../modules/chiV2/chiV2.engine',
    skillGap:          '../../modules/chiV2/skillGapEngine',
    semanticJobMatch:  '../../engines/semanticJobMatching.engine',
    opportunityRadar:  '../../engines/opportunityRadar.engine',
    careerAdvisor:     '../../engines/careerAdvisor.engine',
    marketTrend:       '../../modules/labor-market-intelligence/services/marketTrend.service',
  };
  try {
    _engines[name] = require(paths[name]);
  } catch (err) {
    logger.warn(`[Workers] Engine not available: ${name}`, { err: err.message });
    _engines[name] = null;
  }
  return _engines[name];
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKER 1 — SkillGraphWorker
// Triggered by: CV_PARSED, SKILLS_EXTRACTED, USER_PROFILE_CREATED, CAREER_ANALYSIS_REQUESTED
// ═════════════════════════════════════════════════════════════════════════════

class SkillGraphWorker extends BaseWorker {
  get queueName()       { return QUEUE_NAMES.SKILL_GRAPH; }
  get concurrency()     { return 3; }
  get resultTableName() { return 'skill_graph_results'; }   // future table — for now results go to cache
  get cacheKeyPrefix()  { return 'worker:skill-graph'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const svc        = getEngine('skillGraph');

    if (!svc) throw new Error('SkillGraphEngine not available');

    const [graphResult, gapResult] = await Promise.allSettled([
      svc.getUserSkillGraph(userId),
      svc.detectSkillGap ? svc.detectSkillGap(userId) : Promise.resolve(null),
    ]);

    const graph = graphResult.status === 'fulfilled' ? graphResult.value : null;
    const gap   = gapResult.status   === 'fulfilled' ? gapResult.value  : null;

    if (!graph) throw new Error('SkillGraph engine returned no result');

    return {
      existing_skills:     graph.existing_skills     || [],
      adjacent_skills:     graph.adjacent_skills     || [],
      next_level_skills:   graph.next_level_skills   || [],
      role_specific_skills: graph.role_specific_skills || [],
      missing_high_demand: gap?.missing_high_demand  || [],
      target_role:         graph.target_role         || null,
      industry:            graph.industry            || null,
      skill_count:         graph.skill_count         || 0,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKER 2 — CareerHealthWorker
// Triggered by: CV_PARSED, SKILLS_EXTRACTED, CAREER_ANALYSIS_REQUESTED
// ═════════════════════════════════════════════════════════════════════════════

class CareerHealthWorker extends BaseWorker {
  get queueName()       { return QUEUE_NAMES.CAREER_HEALTH; }
  get concurrency()     { return 2; }
  get resultTableName() { return 'career_health_results'; }
  get cacheKeyPrefix()  { return 'worker:career-health'; }

  async process(job, envelope) {
    const { userId, profile: payloadProfile } = envelope.payload;
    const chiEngine = getEngine('chiV2');
    const skillGapEngine = getEngine('skillGap');

    if (!chiEngine) throw new Error('CHIv2 engine not available');

    // Load profile — use payload if provided (e.g. from CV parse), else default
    const profile = payloadProfile || await this._loadProfile(userId);

    // CHI requires a target_role
    if (!profile.target_role) {
      logger.info('[CareerHealthWorker] No target_role — skipping CHI', { userId });
      return { chi_score: null, dimensions: null, skill_gaps: [], analysis_source: 'skipped_no_target_role' };
    }

    const chiResult = await chiEngine.calculateCHI({
      current_role:     profile.current_role     || null,
      target_role:      profile.target_role,
      skills:           profile.skills           || [],
      skill_levels:     profile.skill_levels     || [],
      education_level:  profile.education_level  || null,
      years_experience: profile.years_experience || 0,
      current_salary:   profile.current_salary   || 0,
    });

    // Get skill gaps for enrichment
    let skillGaps = [];
    try {
      if (skillGapEngine) {
        const gapResult = await skillGapEngine.analyseSkillGap({
          target_role: profile.target_role,
          skills:      profile.skills || [],
        });
        skillGaps = gapResult?.missing_required || [];
      }
    } catch (_) {}

    return {
      chi_score:       chiResult.chi_score || chiResult.score || null,
      dimensions:      chiResult.dimensions || chiResult.scores || null,
      skill_gaps:      skillGaps,
      analysis_source: 'bullmq_async',
    };
  }

  async _loadProfile(userId) {
    const { db } = require('../../config/supabase');
    const snap   = await db.collection('userProfiles').doc(userId).get();
    const data   = snap.exists ? snap.data() : {};
    return {
      target_role:      data.targetRole      || data.currentJobTitle || null,
      current_role:     data.currentRole     || null,
      skills:           Array.isArray(data.skills) ? data.skills.map(s => typeof s === 'string' ? s : s?.name).filter(Boolean) : [],
      skill_levels:     data.skillLevels     || [],
      education_level:  data.educationLevel  || null,
      years_experience: data.experienceYears || data.yearsExperience || 0,
      current_salary:   data.currentSalary   || 0,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKER 3 — JobMatchingWorker
// Triggered by: CV_PARSED, SKILLS_EXTRACTED, JOB_MATCH_REQUESTED, CAREER_ANALYSIS_REQUESTED
// ═════════════════════════════════════════════════════════════════════════════

class JobMatchingWorker extends BaseWorker {
  get queueName()       { return QUEUE_NAMES.JOB_MATCHING; }
  get concurrency()     { return 3; }
  get resultTableName() { return 'job_match_results'; }
  get cacheKeyPrefix()  { return 'worker:job-matching'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const jobMatchSvc = getEngine('jobMatching');

    if (!jobMatchSvc) throw new Error('JobMatchingEngine not available');

    let result;
    let scoringMode = 'keyword';

    // Use semantic matching if feature flag enabled
    if (process.env.FEATURE_SEMANTIC_MATCHING === 'true') {
      try {
        const semanticSvc = getEngine('semanticJobMatch');
        if (semanticSvc) {
          const skillGraphSvc = getEngine('skillGraph');
          const skillGap      = skillGraphSvc
            ? await skillGraphSvc.getUserSkillGraph(userId).catch(() => null)
            : null;

          const candidateResult = await jobMatchSvc.getJobMatches(userId, { limit: 50 });
          const candidates      = (candidateResult?.recommended_jobs || []).map(j => ({
            id:            j.id || j.roleId,
            title:         j.title,
            description:   j.description || '',
            skills:        j.required_skills || [],
            company:       j.company || null,
            location:      j.location || null,
            yearsRequired: j.yearsRequired || 0,
            industry:      j.sector || null,
          }));

          const userProfile = {
            userId,
            skills:          skillGap?.existing_skills || [],
            yearsExperience: skillGap?.years_experience || 0,
            industry:        skillGap?.industry || '',
          };

          const semanticResult = await semanticSvc.getSemanticJobRecommendations(
            userProfile, candidates, { topN: 10, minScore: 30 }
          );

          result      = semanticResult;
          scoringMode = 'semantic';
        }
      } catch (err) {
        logger.warn('[JobMatchingWorker] Semantic fallback to keyword', { err: err.message });
      }
    }

    // Fallback to keyword matching
    if (!result) {
      result = await jobMatchSvc.getJobMatches(userId, { limit: 10 });
    }

    return {
      recommended_jobs:  result?.recommended_jobs  || result?.jobs || [],
      total_evaluated:   result?.total_roles_evaluated || 0,
      user_skills_count: result?.user_skills_count || 0,
      scoring_mode:      scoringMode,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKER 4 — RiskAnalysisWorker
// Triggered by: CV_PARSED, RISK_ANALYSIS_REQUESTED, CAREER_ANALYSIS_REQUESTED
// ═════════════════════════════════════════════════════════════════════════════

class RiskAnalysisWorker extends BaseWorker {
  get queueName()       { return QUEUE_NAMES.RISK_ANALYSIS; }
  get concurrency()     { return 2; }
  get resultTableName() { return 'risk_analysis_results'; }
  get cacheKeyPrefix()  { return 'worker:risk-analysis'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;

    // CareerRiskPredictorEngine — try to load (may be in different module path)
    let riskEngine;
    try {
      riskEngine = require('../../engines/careerRisk.engine');
    } catch (_) {
      try {
        riskEngine = require('../../modules/careerRisk/careerRisk.engine');
      } catch (_) {
        logger.warn('[RiskAnalysisWorker] CareerRisk engine not found — using stub');
      }
    }

    if (!riskEngine) {
      // Graceful degradation: return minimal result if engine not yet built
      return this._stubResult(userId);
    }

    const result = await riskEngine.analyzeCareerRisk(userId);

    return {
      overall_risk_score: result.overall_risk_score || result.riskScore || 0,
      risk_level:         result.risk_level || result.riskLevel || 'Medium',
      risk_factors:       result.risk_factors || result.factors || [],
      recommendations:    result.recommendations || [],
      market_stability:   result.market_stability || null,
    };
  }

  _stubResult(userId) {
    logger.info('[RiskAnalysisWorker] Using stub result', { userId });
    return {
      overall_risk_score: null,
      risk_level:         null,
      risk_factors:       [],
      recommendations:    [],
      market_stability:   null,
      _stub:              true,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKER 5 — OpportunityRadarWorker
// Triggered by: CV_PARSED, OPPORTUNITY_SCAN_REQUESTED, CAREER_ANALYSIS_REQUESTED
// ═════════════════════════════════════════════════════════════════════════════

class OpportunityRadarWorker extends BaseWorker {
  get queueName()       { return QUEUE_NAMES.OPPORTUNITY_RADAR; }
  get concurrency()     { return 2; }
  get resultTableName() { return 'opportunity_radar_results'; }
  get cacheKeyPrefix()  { return 'worker:opportunity-radar'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const radarEngine = getEngine('opportunityRadar');

    if (!radarEngine) throw new Error('OpportunityRadarEngine not available');

    const result = await radarEngine.getOpportunityRadar(userId, {
      topN:               10,
      minOpportunityScore: 40,
    });

    return {
      emerging_opportunities:  result.emerging_opportunities  || [],
      total_signals_evaluated: result.total_signals_evaluated || 0,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKER 6 — CareerAdvisorWorker (Claude LLM call)
// Triggered by: CAREER_ADVICE_REQUESTED, CAREER_ANALYSIS_REQUESTED
// ═════════════════════════════════════════════════════════════════════════════

class CareerAdvisorWorker extends BaseWorker {
  get queueName()       { return QUEUE_NAMES.CAREER_ADVISOR; }
  get concurrency()     { return 1; }  // LLM — keep concurrency low
  get resultTableName() { return 'career_advice_results'; }
  get cacheKeyPrefix()  { return 'worker:career-advisor'; }

  async process(job, envelope) {
    const { userId } = envelope.payload;
    const advisorEngine  = getEngine('careerAdvisor');
    const skillGraphSvc  = getEngine('skillGraph');
    const marketSvc      = getEngine('marketTrend');
    const jobMatchSvc    = getEngine('jobMatching');

    if (!advisorEngine) throw new Error('CareerAdvisorEngine not available');

    // Gather context in parallel
    const [skillGapRes, jobMatchRes, marketRes] = await Promise.allSettled([
      skillGraphSvc ? skillGraphSvc.detectSkillGap
        ? skillGraphSvc.detectSkillGap(userId)
        : skillGraphSvc.getUserSkillGraph(userId)
      : Promise.resolve(null),
      jobMatchSvc ? jobMatchSvc.getJobMatches(userId, { limit: 5 }) : Promise.resolve(null),
      marketSvc   ? marketSvc.getTrendingSkills ? marketSvc.getTrendingSkills() : Promise.resolve(null) : Promise.resolve(null),
    ]);

    const skillGap     = skillGapRes.status   === 'fulfilled' ? skillGapRes.value   : {};
    const jobMatches   = jobMatchRes.status   === 'fulfilled' ? jobMatchRes.value?.recommended_jobs || [] : [];
    const marketDemand = marketRes.status     === 'fulfilled' ? marketRes.value     : null;

    const profile = {
      skills:          skillGap?.existing_skills  || [],
      yearsExperience: skillGap?.years_experience || 0,
      targetRole:      skillGap?.target_role      || null,
      industry:        skillGap?.industry         || null,
    };

    const advice = await advisorEngine.generateCareerAdvice({
      userId,
      profile,
      skillGap,
      marketDemand,
      topJobMatches: jobMatches,
    });

    return {
      career_insight:       advice.career_insight       || null,
      key_opportunity:      advice.key_opportunity      || null,
      salary_potential:     advice.salary_potential     || null,
      timeline:             advice.timeline             || null,
      skills_to_prioritise: advice.skills_to_prioritise || [],
      profile_hash:         advice._profile_hash        || null,
    };
  }
}

// ─── Worker registry ──────────────────────────────────────────────────────────

/**
 * Registry of all worker instances.
 * Call startAll() in server.js (or a dedicated worker process) to activate.
 */
const WORKERS = {
  skillGraph:       new SkillGraphWorker(),
  careerHealth:     new CareerHealthWorker(),
  jobMatching:      new JobMatchingWorker(),
  riskAnalysis:     new RiskAnalysisWorker(),
  opportunityRadar: new OpportunityRadarWorker(),
  careerAdvisor:    new CareerAdvisorWorker(),
};

/**
 * Start all workers.
 * Call this in server.js when FEATURE_EVENT_BUS=true:
 *
 *   if (process.env.FEATURE_EVENT_BUS === 'true') {
 *     require('./modules/ai-event-bus/workers').startAll();
 *   }
 */
function startAll() {
  for (const [name, worker] of Object.entries(WORKERS)) {
    try {
      worker.start();
      logger.info('[Workers] Started', { name });
    } catch (err) {
      logger.error('[Workers] Failed to start', { name, err: err.message });
    }
  }
}

/**
 * Stop all workers gracefully.
 * Hook into SIGTERM/SIGINT in server.js.
 */
async function stopAll() {
  await Promise.allSettled(Object.values(WORKERS).map(w => w.stop()));
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









