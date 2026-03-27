'use strict';

/**
 * ragRetriever.js — RAG Context Retriever
 *
 * Retrieves and assembles grounded context from all platform engines
 * before any LLM call. This is the "R" in RAG.
 *
 * Sources retrieved (all parallel, all graceful-fail):
 *   1. user_profile          — Firestore userProfiles (skills, experience, role)
 *   2. chi_score             — Career Health Index
 *   3. skill_gaps            — SkillGraphEngine.detectSkillGap / getUserSkillGraph
 *   4. job_matches           — JobMatchingEngine top results
 *   5. opportunity_radar     — OpportunityRadarEngine personalised results
 *   6. risk_analysis         — Supabase risk_analysis_results table
 *   7. salary_benchmarks     — SalaryService for target role
 *   8. personalization_profile — AIPersonalizationEngine profile
 *
 * Output: RAGContext object with:
 *   - All retrieved data (null for unavailable sources)
 *   - data_sources_used[]   — list of non-null sources
 *   - data_completeness     — 0–1 fraction of sources populated
 *   - confidence_score      — weighted quality metric
 *
 * Design:
 *   - Every source fetch is wrapped in Promise.allSettled — one source
 *     failing NEVER blocks the others
 *   - Results are cached per user (5 min TTL) — context is re-fetched
 *     at most once per 5 minutes regardless of query frequency
 *   - Sources are tagged with metadata (freshness, record count) for
 *     inclusion in the confidence calculation
 *
 * @module src/modules/career-copilot/retrieval/ragRetriever
 */

const supabase       = require('../../../core/supabaseClient');
const cacheManager   = require('../../../core/cache/cache.manager');
const logger         = require('../../../utils/logger');
const { db }         = require('../../../config/supabase');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONTEXT_CACHE_TTL = 300;   // 5 minutes — context refreshes periodically

// Minimum fraction of sources that must be populated for the Copilot
// to attempt a grounded response. Below this → polite refusal.
const MIN_COMPLETENESS_THRESHOLD = 0.25;   // at least 2 of 8 sources

// Source weights for confidence calculation
// (sources with richer, more specific data get higher weight)
const SOURCE_WEIGHTS = Object.freeze({
  user_profile:          0.20,   // always available after onboarding
  chi_score:             0.15,   // computed after CV upload
  skill_gaps:            0.15,   // from skill graph engine
  job_matches:           0.15,   // from job matching engine
  opportunity_radar:     0.12,   // from opportunity radar engine
  risk_analysis:         0.10,   // from risk predictor
  salary_benchmarks:     0.08,   // from salary service
  personalization_profile: 0.05, // from personalization engine
});

const ALL_SOURCES = Object.keys(SOURCE_WEIGHTS);

const cache = cacheManager.getClient();

// ─── Lazy engine loaders ──────────────────────────────────────────────────────

function _load(path) {
  try { return require(path); } catch (_) { return null; }
}

// ─── Individual source fetchers ───────────────────────────────────────────────

/**
 * Fetch user profile from Firestore.
 */
async function _fetchUserProfile(userId) {
  const [profileSnap, progressSnap] = await Promise.all([
    db.collection('userProfiles').doc(userId).get(),
    db.collection('onboardingProgress').doc(userId).get(),
  ]);

  const profile  = profileSnap.exists  ? profileSnap.data()  : {};
  const progress = progressSnap.exists ? progressSnap.data() : {};

  const rawSkills =
    (Array.isArray(profile.skills) && profile.skills.length > 0)
      ? profile.skills
      : (Array.isArray(progress.skills) ? progress.skills : []);

  const skills = rawSkills
    .map(s => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean);

  if (skills.length === 0 && !profile.targetRole) return null;

  return {
    skills,
    target_role:      profile.targetRole || profile.currentJobTitle || null,
    current_role:     profile.currentRole || null,
    industry:         profile.industry || null,
    years_experience: profile.experienceYears || profile.yearsExperience || 0,
    education_level:  profile.educationLevel || null,
    current_salary:   profile.currentSalary || null,
    location:         profile.location || null,
  };
}

/**
 * Fetch CHI score from Firestore (existing chi snapshots).
 */
async function _fetchCHIScore(userId) {
  // FIX: ragRetriever was querying a top-level 'chiSnapshots' collection that
  // does not exist and has no Firestore composite index — causing:
  //   "9 FAILED_PRECONDITION: The query requires an index"
  //
  // The actual data lives in two places (written by chiSnapshot.repository.js):
  //   1. users/{userId}/chiSnapshots/{id}  — primary subcollection (fast path)
  //   2. chiSnapshots_index/{id}           — lightweight flat index
  //   3. careerHealthIndex/{id}            — legacy flat collection (fallback)
  //
  // No composite index is needed for the subcollection query (scoped by userId).

  // Fast path: per-user subcollection (no composite index needed)
  try {
    const snap = await db
      .collection('users').doc(userId)
      .collection('chiSnapshots')
      .where('softDeleted', '==', false)
      .orderBy('generatedAt', 'desc')
      .limit(1)
      .get();

    if (!snap.empty) {
      const data = snap.docs[0].data();
      return {
        chi_score:       data.chiScore || data.chi_score || null,
        dimensions:      data.dimensions || null,
        analysis_source: data.analysisSource || 'unknown',
        calculated_at:   data.generatedAt?.toDate?.()?.toISOString() || null,
      };
    }
  } catch (_) { /* fall through to legacy */ }

  // Fallback: legacy careerHealthIndex flat collection
  try {
    const snap = await db
      .collection('careerHealthIndex')
      .where('userId', '==', userId)
      .orderBy('generatedAt', 'desc')
      .limit(1)
      .get();

    if (!snap.empty) {
      const data = snap.docs[0].data();
      return {
        chi_score:       data.chiScore || data.chi_score || null,
        dimensions:      data.dimensions || null,
        analysis_source: data.analysisSource || 'unknown',
        calculated_at:   data.generatedAt?.toDate?.()?.toISOString() || null,
      };
    }
  } catch (_) { /* non-fatal */ }

  return null;
}

/**
 * Fetch skill gap data using existing SkillGraphEngine.
 */
async function _fetchSkillGaps(userId) {
  const svc = _load('../../../modules/jobSeeker/skillGraphEngine.service');
  if (!svc) return null;

  const result = await (svc.detectSkillGap || svc.getUserSkillGraph).call(svc, userId);
  if (!result) return null;

  return {
    existing_skills:     result.existing_skills     || [],
    missing_high_demand: (result.missing_high_demand || []).slice(0, 8),
    adjacent_skills:     (result.adjacent_skills     || []).slice(0, 6),
    role_gap:            result.role_gap             || null,
    target_role:         result.target_role          || null,
  };
}

/**
 * Fetch job matches using existing JobMatchingEngine.
 */
async function _fetchJobMatches(userId) {
  const svc = _load('../../../modules/jobSeeker/jobMatchingEngine.service');
  if (!svc) return null;

  const result = await svc.getJobMatches(userId, { limit: 5 });
  if (!result || !result.recommended_jobs?.length) return null;

  return {
    top_matches:    result.recommended_jobs.slice(0, 5).map(j => ({
      title:          j.title,
      match_score:    j.match_score,
      missing_skills: (j.missing_skills || []).slice(0, 4),
      salary:         j.salary || null,
      company:        j.company || null,
    })),
    total_evaluated: result.total_roles_evaluated || 0,
  };
}

/**
 * Fetch opportunity radar from Supabase result table
 * (written by OpportunityRadarWorker or direct engine call).
 */
async function _fetchOpportunityRadar(userId) {
  // Try Supabase result table first (fastest — pre-computed)
  const { data: stored } = await supabase
    .from('opportunity_radar_results')
    .select('emerging_opportunities, total_signals_evaluated, computed_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (stored?.emerging_opportunities?.length > 0) {
    return {
      emerging_opportunities: (stored.emerging_opportunities || []).slice(0, 5),
      total_evaluated:        stored.total_signals_evaluated,
      source:                 'precomputed',
      computed_at:            stored.computed_at,
    };
  }

  // Fallback: try live engine
  const engine = _load('../../../engines/opportunityRadar.engine');
  if (!engine) return null;

  const result = await engine.getOpportunityRadar(userId, { topN: 5, minOpportunityScore: 40 });
  if (!result?.emerging_opportunities?.length) return null;

  return {
    emerging_opportunities: result.emerging_opportunities.slice(0, 5),
    total_evaluated:        result.total_signals_evaluated || 0,
    source:                 'live',
  };
}

/**
 * Fetch risk analysis from Supabase result table.
 */
async function _fetchRiskAnalysis(userId) {
  const { data } = await supabase
    .from('risk_analysis_results')
    .select('overall_risk_score, risk_level, risk_factors, recommendations, computed_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data || data.overall_risk_score === null) return null;

  return {
    overall_risk_score: data.overall_risk_score,
    risk_level:         data.risk_level,
    risk_factors:       (data.risk_factors || []).slice(0, 4),
    recommendations:    (data.recommendations || []).slice(0, 3),
    computed_at:        data.computed_at,
  };
}

/**
 * Fetch salary benchmarks for the user's target role.
 */
async function _fetchSalaryBenchmarks(userId, targetRole) {
  if (!targetRole) return null;

  try {
    const svc = _load('../../../modules/salary/salaryAggregation.service');
    if (!svc) {
      // Fallback: try Supabase salary_benchmarks table
      const { data } = await supabase
        .from('salary_benchmarks')
        .select('role_name, median_salary, min_salary, max_salary, industry, location')
        .ilike('role_name', `%${targetRole.split(' ')[0]}%`)
        .limit(3);

      if (data?.length > 0) {
        return { benchmarks: data, source: 'supabase' };
      }
      return null;
    }

    const result = await svc.aggregateSalaries
      ? svc.aggregateSalaries(targetRole)
      : svc.getAggregatedSalary?.(targetRole);

    if (!result) return null;

    return {
      role:           targetRole,
      median_salary:  result.medianSalary || result.median_salary || null,
      min_salary:     result.minSalary    || result.min_salary    || null,
      max_salary:     result.maxSalary    || result.max_salary    || null,
      currency:       'INR',
      source:         'salary_service',
    };
  } catch (_) {
    return null;
  }
}

/**
 * Fetch personalization profile from Supabase.
 */
async function _fetchPersonalizationProfile(userId) {
  const { data } = await supabase
    .from('user_personalization_profile')
    .select('preferred_roles, preferred_skills, career_interests, engagement_score, total_events')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data || data.total_events === 0) return null;

  return {
    preferred_roles:  (data.preferred_roles  || []).slice(0, 5),
    preferred_skills: (data.preferred_skills || []).slice(0, 5),
    career_interests: (data.career_interests || []).slice(0, 3),
    engagement_score: data.engagement_score,
    total_events:     data.total_events,
  };
}

// ─── Confidence calculation ───────────────────────────────────────────────────

/**
 * Calculate confidence score from retrieved context.
 *
 * confidence = sum(weight_i × populated_i) for each source
 * where populated_i = 1 if source is non-null, else 0
 *
 * Bonus +0.1 for profile completeness (skills + target role present)
 */
function _calculateConfidence(context) {
  let score = 0;

  for (const [source, weight] of Object.entries(SOURCE_WEIGHTS)) {
    if (context[source] !== null && context[source] !== undefined) {
      score += weight;
    }
  }

  // Profile bonus
  const profile = context.user_profile;
  if (profile?.skills?.length > 0 && profile?.target_role) {
    score = Math.min(1.0, score + 0.05);
  }

  return Math.round(score * 1000) / 1000;
}

/**
 * Calculate data completeness (0–1) = populated sources / total sources.
 */
function _calculateCompleteness(context) {
  const populated = ALL_SOURCES.filter(s => context[s] !== null).length;
  return Math.round((populated / ALL_SOURCES.length) * 1000) / 1000;
}

// ═════════════════════════════════════════════════════════════════════════════
// retrieveContext(userId) — main public function
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Retrieve all available platform data for a user to ground the Copilot response.
 *
 * All 8 sources are fetched in parallel. Each failure is independent — one
 * source throwing will not prevent other sources from being returned.
 *
 * @param {string} userId
 * @param {{ forceRefresh?: boolean }} opts
 * @returns {Promise<RAGContext>}
 */
async function retrieveContext(userId, opts = {}) {
  const { forceRefresh = false } = opts;
  const cacheKey = `rag:context:${userId}`;

  // Cache hit (5-minute TTL — context is stable for short query bursts)
  if (!forceRefresh) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        logger.debug('[RAGRetriever] Context cache hit', { userId });
        return { ...parsed, _cached: true };
      }
    } catch (_) {}
  }

  logger.info('[RAGRetriever] Fetching context from all sources', { userId });
  const startMs = Date.now();

  // Fetch all sources in parallel — allSettled ensures partial results
  const [
    profileRes,
    chiRes,
    skillGapRes,
    jobMatchRes,
    opportunityRes,
    riskRes,
    salaryRes,
    personalizationRes,
  ] = await Promise.allSettled([
    _fetchUserProfile(userId),
    _fetchCHIScore(userId),
    _fetchSkillGaps(userId),
    _fetchJobMatches(userId),
    _fetchOpportunityRadar(userId),
    _fetchRiskAnalysis(userId),
    null,   // salary is fetched after profile (needs target_role)
    _fetchPersonalizationProfile(userId),
  ]);

  // Unwrap settled results
  const userProfile       = profileRes.status   === 'fulfilled' ? profileRes.value       : null;
  const chiScore          = chiRes.status        === 'fulfilled' ? chiRes.value           : null;
  const skillGaps         = skillGapRes.status   === 'fulfilled' ? skillGapRes.value      : null;
  const jobMatches        = jobMatchRes.status   === 'fulfilled' ? jobMatchRes.value      : null;
  const opportunityRadar  = opportunityRes.status=== 'fulfilled' ? opportunityRes.value   : null;
  const riskAnalysis      = riskRes.status       === 'fulfilled' ? riskRes.value          : null;
  const personalization   = personalizationRes.status === 'fulfilled' ? personalizationRes.value : null;

  // Fetch salary separately — needs target_role from profile
  let salaryBenchmarks = null;
  const targetRole = userProfile?.target_role || skillGaps?.target_role;
  if (targetRole) {
    try {
      salaryBenchmarks = await _fetchSalaryBenchmarks(userId, targetRole);
    } catch (_) {}
  }

  // Log any retrieval failures
  const failures = [
    profileRes, chiRes, skillGapRes, jobMatchRes,
    opportunityRes, riskRes, personalizationRes,
  ].filter(r => r.status === 'rejected');

  if (failures.length > 0) {
    logger.warn('[RAGRetriever] Some sources failed', {
      userId, failed: failures.length,
      errors: failures.map(f => f.reason?.message).filter(Boolean),
    });
  }

  // Assemble context
  const context = {
    user_profile:            userProfile,
    chi_score:               chiScore,
    skill_gaps:              skillGaps,
    job_matches:             jobMatches,
    opportunity_radar:       opportunityRadar,
    risk_analysis:           riskAnalysis,
    salary_benchmarks:       salaryBenchmarks,
    personalization_profile: personalization,
  };

  // Compute quality metrics
  const dataCompleteness = _calculateCompleteness(context);
  const confidenceScore  = _calculateConfidence(context);
  const dataSourcesUsed  = ALL_SOURCES.filter(s => context[s] !== null);

  const ragContext = {
    ...context,
    data_sources_used:  dataSourcesUsed,
    data_completeness:  dataCompleteness,
    confidence_score:   confidenceScore,
    is_sufficient:      dataCompleteness >= MIN_COMPLETENESS_THRESHOLD,
    retrieval_ms:       Date.now() - startMs,
    retrieved_at:       new Date().toISOString(),
  };

  logger.info('[RAGRetriever] Context assembled', {
    userId,
    sources:      dataSourcesUsed.length,
    completeness: dataCompleteness,
    confidence:   confidenceScore,
    ms:           ragContext.retrieval_ms,
  });

  // Cache context
  try {
    await cache.set(cacheKey, JSON.stringify(ragContext), 'EX', CONTEXT_CACHE_TTL);
  } catch (_) {}

  return ragContext;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  retrieveContext,
  MIN_COMPLETENESS_THRESHOLD,
  SOURCE_WEIGHTS,
  ALL_SOURCES,
};









