'use strict';

/**
 * careerAgentCoordinator.js — Career Agent Coordinator
 *
 * Central coordinator for the multi-agent Career Copilot.
 *
 * Execution flow:
 *   1. classifyIntent(userQuery)         — keyword-based intent detection
 *   2. selectAgents(intent)              — map intent → relevant agent subset
 *   3. Promise.allSettled(agents)        — run selected agents in parallel
 *   4. CareerAdvisorAgent.execute()      — synthesize outputs → final answer
 *   5. Cache full response (10 min)      — coordinator-level cache
 *   6. Persist to Supabase               — agent_responses table
 *
 * Design principles:
 *   - Each agent fails independently (allSettled, never allSettled)
 *   - Always returns a response, even with partial data
 *   - No existing engines are modified — agents call them as consumers
 *   - Coordinator cache key is userId + intent (stable for 10 min)
 *   - forceRefresh bypasses both coordinator cache AND individual agent caches
 *
 * Intent → Agent routing:
 *   skill       → SkillIntelligenceAgent + MarketIntelligenceAgent
 *   jobs        → JobMatchingAgent + SkillIntelligenceAgent
 *   salary      → MarketIntelligenceAgent + JobMatchingAgent
 *   risk        → CareerRiskAgent + MarketIntelligenceAgent
 *   opportunity → OpportunityRadarAgent + MarketIntelligenceAgent
 *   transition  → SkillIntelligenceAgent + JobMatchingAgent + OpportunityRadarAgent
 *   general     → all five agents
 *   full        → all five agents (explicit full-analysis request)
 *
 * File location: src/modules/career-copilot/coordinator/careerAgentCoordinator.js
 *
 * @module src/modules/career-copilot/coordinator/careerAgentCoordinator
 */

'use strict';

const { randomUUID }    = require('crypto');
const cacheManager       = require('../../../core/cache/cache.manager');
const supabase           = require('../../../core/supabaseClient');
const { db }             = require('../../../config/supabase');
const logger             = require('../../../utils/logger');

// ── Agent imports (each file in same agents/ directory) ──────────────────────
const BaseAgent              = require('../agents/baseAgent');
const SkillIntelligenceAgent = require('../agents/skillIntelligenceAgent');
const JobMatchingAgent       = require('../agents/jobMatchingAgent');
const MarketIntelligenceAgent = require('../agents/marketIntelligenceAgent');
const { CareerRiskAgent, OpportunityRadarAgent } = require('../agents/riskAndRadarAgents');
const CareerAdvisorAgent     = require('../agents/careerAdvisorAgent');

const COORDINATOR_CACHE_TTL = 600; // 10 minutes
const cache = cacheManager.getClient();

// ─── Agent registry (singleton instances) ────────────────────────────────────

const AGENTS = {
  skill:       new SkillIntelligenceAgent(),
  jobs:        new JobMatchingAgent(),
  market:      new MarketIntelligenceAgent(),
  risk:        new CareerRiskAgent(),
  opportunity: new OpportunityRadarAgent(),
};

const advisorAgent = new CareerAdvisorAgent();

// ─── Intent → agent key mapping ──────────────────────────────────────────────

const INTENT_MAP = Object.freeze({
  skill:       ['skill', 'market'],
  jobs:        ['jobs', 'skill'],
  salary:      ['market', 'jobs'],
  risk:        ['risk', 'market'],
  opportunity: ['opportunity', 'market'],
  transition:  ['skill', 'jobs', 'opportunity'],
  general:     ['skill', 'jobs', 'market', 'risk', 'opportunity'],
  full:        ['skill', 'jobs', 'market', 'risk', 'opportunity'],
});

// ─── Intent classifier ────────────────────────────────────────────────────────

/**
 * Classify user query into one of the INTENT_MAP keys.
 * Order matters — more specific patterns are checked first.
 */
function classifyIntent(query) {
  if (!query) return 'general';
  const q = query.toLowerCase();

  if (/\bskill|learn|gap|upskill|course|training|missing skill|improve skill/.test(q)) return 'skill';
  if (/\bsalary|pay|earn|income|ctc|lpa|package|compensation|how much/.test(q))         return 'salary';
  if (/\brisk|safe|stable|automat|threaten|vulnerable|obsolete|job security/.test(q))   return 'risk';
  if (/\bopportunit|emerging|growth|future|trending|in demand|hot role/.test(q))        return 'opportunity';
  if (/\bjob|role|position|apply|match|hiring|open role|recrui/.test(q))                return 'jobs';
  if (/\btransit|switch|move into|career change|pivot|change career/.test(q))           return 'transition';
  if (/\bcareer|path|next|progress|advanc|plan|direction/.test(q))                      return 'transition';

  return 'general';
}

// ─── User profile loader ──────────────────────────────────────────────────────

async function _loadUserProfile(userId) {
  try {
    const [profileSnap, progressSnap] = await Promise.all([
      db.collection('userProfiles').doc(userId).get(),
      db.collection('onboardingProgress').doc(userId).get(),
    ]);

    const profile  = profileSnap.exists  ? profileSnap.data()  : {};
    const progress = progressSnap.exists ? progressSnap.data() : {};

    const rawSkills =
      Array.isArray(profile.skills) && profile.skills.length > 0
        ? profile.skills
        : (Array.isArray(progress.skills) ? progress.skills : []);

    const skills = rawSkills
      .map(s => (typeof s === 'string' ? s : s?.name))
      .filter(Boolean);

    return {
      skills,
      target_role:      profile.targetRole      || profile.currentJobTitle || null,
      current_role:     profile.currentRole      || null,
      industry:         profile.industry         || null,
      years_experience: profile.experienceYears  || profile.yearsExperience || 0,
      education_level:  profile.educationLevel   || null,
      location:         profile.location         || null,
    };
  } catch (err) {
    logger.warn('[Coordinator] Profile load failed', { userId, err: err.message });
    return { skills: [], target_role: null, industry: null, years_experience: 0 };
  }
}

// ─── Persistence helpers ──────────────────────────────────────────────────────

async function _upsertSession(userId, sessionId, intent, agentsUsed) {
  try {
    await supabase.from('agent_sessions').upsert({
      session_id:       sessionId,
      user_id:          userId,
      last_active_at:   new Date().toISOString(),
      detected_intents: [intent],
      agents_activated: agentsUsed,
    }, { onConflict: 'session_id', ignoreDuplicates: false });
  } catch (_) { /* non-fatal */ }
}

async function _persistResponse(userId, sessionId, turnIndex, {
  userQuery, intent, agentsUsed, agentErrors,
  response, confidence, dataCompleteness, durationMs, cachedCount,
}) {
  try {
    await supabase.from('agent_responses').insert({
      user_id:          userId,
      session_id:       sessionId,
      turn_index:       turnIndex,
      user_query:       userQuery,
      intent,
      agents_used:      agentsUsed,
      agent_errors:     agentErrors,
      response,
      confidence,
      data_completeness: dataCompleteness,
      duration_ms:      durationMs,
      cached_agents:    cachedCount,
    });
  } catch (_) { /* non-fatal */ }
}

// ─── Coordinator cache helpers ────────────────────────────────────────────────

function _cacheKey(userId, intent) {
  return `coordinator:${userId}:${intent}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// coordinate() — main public function
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run the full multi-agent pipeline for a user query.
 *
 * @param {string}  userId
 * @param {string|null} userQuery     — user's question, or null for full analysis
 * @param {{ forceRefresh?: boolean, sessionId?: string, agentSubset?: string[] }} opts
 *
 * @returns {Promise<CoordinatorResponse>}
 */
async function coordinate(userId, userQuery = null, opts = {}) {
  const {
    forceRefresh = false,
    sessionId    = randomUUID(),
    agentSubset  = null,    // caller can override which agents to run
  } = opts;

  const startMs   = Date.now();
  const intent    = classifyIntent(userQuery);
  const agentKeys = agentSubset || INTENT_MAP[intent] || INTENT_MAP.general;

  logger.info('[Coordinator] Pipeline start', {
    userId, intent, agents: agentKeys.join(','), sessionId,
  });

  // ── Coordinator-level cache ───────────────────────────────────────────────
  const coordKey = _cacheKey(userId, intent);
  if (!forceRefresh) {
    try {
      const hit = await cache.get(coordKey);
      if (hit) {
        const parsed = JSON.parse(hit);
        logger.debug('[Coordinator] Cache hit', { userId, intent });
        return { ...parsed, _cached: true, session_id: sessionId };
      }
    } catch (_) {}
  }

  // ── Load user profile ─────────────────────────────────────────────────────
  const userProfile = await _loadUserProfile(userId);
  const agentContext = {
    ...userProfile,
    existing_skills: userProfile.skills,
  };

  // ── Execute selected agents in parallel ───────────────────────────────────
  const selectedAgents = agentKeys
    .filter(k => AGENTS[k])
    .map(k => ({ key: k, agent: AGENTS[k] }));

  const settled = await Promise.allSettled(
    selectedAgents.map(({ agent }) =>
      agent.execute(userId, agentContext, { forceRefresh })
    )
  );

  // ── Unpack results ────────────────────────────────────────────────────────
  const agentOutputs = {};   // { skill: {...}, jobs: {...}, ... }
  const agentsUsed   = [];
  const agentErrors  = [];
  let   cachedCount  = 0;

  selectedAgents.forEach(({ key }, i) => {
    const result = settled[i];
    if (result.status === 'fulfilled' && result.value.output !== null) {
      agentOutputs[key] = result.value.output;
      agentsUsed.push(result.value.agent);
      if (result.value.cached) cachedCount++;
    } else {
      const errMsg = result.status === 'rejected'
        ? result.reason?.message
        : result.value?.error;

      agentErrors.push({ agent: selectedAgents[i].agent.agentName, error: errMsg });
      agentOutputs[key] = null;
      logger.warn('[Coordinator] Agent failed', {
        agent: selectedAgents[i].agent.agentName, err: errMsg,
      });
    }
  });

  logger.info('[Coordinator] Agents done', {
    userId, succeeded: agentsUsed.length, failed: agentErrors.length,
    cached: cachedCount,
  });

  // ── CareerAdvisorAgent: synthesis ─────────────────────────────────────────
  const advisorResult = await advisorAgent.execute(
    userId,
    { userQuery, agentOutputs, userProfile },
    { forceRefresh }
  );

  const advisorOutput    = advisorResult.output || {};
  const aiRecommendation = advisorOutput.ai_recommendation || '';
  const structuredOutput = advisorOutput.structured_output || {};

  // ── Confidence + completeness ─────────────────────────────────────────────
  const allAgentCount      = Object.keys(AGENTS).length;  // 5
  const dataCompleteness   = agentsUsed.length / allAgentCount;
  const confidence         = Math.round(
    Math.min(0.99, dataCompleteness * 0.6 + (advisorOutput ? 0.4 : 0.1)) * 1000
  ) / 1000;

  // ── Build final response ──────────────────────────────────────────────────
  const response = {
    session_id:        sessionId,
    intent_detected:   intent,
    agents_used:       [...agentsUsed, advisorAgent.agentName],
    agent_errors:      agentErrors,

    // Core structured data (from CareerAdvisorAgent.structured_output)
    skills_to_learn:   structuredOutput.skills_to_learn   || [],
    adjacent_skills:   structuredOutput.adjacent_skills   || [],
    learning_paths:    structuredOutput.learning_paths    || [],
    job_matches:       structuredOutput.job_matches       || [],
    career_risk:       structuredOutput.career_risk       || null,
    risk_score:        structuredOutput.risk_score        ?? null,
    risk_factors:      structuredOutput.risk_factors      || [],
    opportunities:     structuredOutput.opportunities     || [],
    trending_skills:   structuredOutput.trending_skills   || [],
    target_role_salary: structuredOutput.target_role_salary || null,

    // AI synthesis
    ai_recommendation: aiRecommendation,

    // Metadata
    confidence,
    data_completeness: dataCompleteness,
    duration_ms:       Date.now() - startMs,
    generated_at:      new Date().toISOString(),
  };

  // ── Cache coordinator response ────────────────────────────────────────────
  try {
    await cache.set(coordKey, JSON.stringify(response), 'EX', COORDINATOR_CACHE_TTL);
  } catch (_) {}

  // ── Persist to Supabase (non-blocking) ────────────────────────────────────
  const turnIndex = 0; // incremented by session logic
  Promise.all([
    _upsertSession(userId, sessionId, intent, agentsUsed),
    _persistResponse(userId, sessionId, turnIndex, {
      userQuery, intent, agentsUsed, agentErrors,
      response, confidence, dataCompleteness,
      durationMs: response.duration_ms,
      cachedCount,
    }),
  ]).catch(() => {});

  return response;
}

// ─── getAgentStatus ───────────────────────────────────────────────────────────

/** Returns registry metadata for the /agent/status endpoint. */
async function getAgentStatus() {
  return {
    agents: Object.fromEntries(
      [...Object.entries(AGENTS), ['advisor', advisorAgent]].map(([k, a]) => [
        k, { name: a.agentName, cachePrefix: a.cachePrefix },
      ])
    ),
    intent_map: INTENT_MAP,
    total_agents: Object.keys(AGENTS).length + 1,
  };
}

// ─── invalidateUserCache ─────────────────────────────────────────────────────

/** Clears all agent + coordinator caches for a user. Call after CV upload. */
async function invalidateUserCache(userId) {
  const tasks = [
    // Per-agent caches
    ...Object.values(AGENTS).map(a => a.invalidateCache(userId)),
    advisorAgent.invalidateCache(userId),
    // Coordinator caches (all intents)
    ...Object.keys(INTENT_MAP).map(intent =>
      cache.del(_cacheKey(userId, intent)).catch(() => {})
    ),
  ];

  await Promise.allSettled(tasks);
  logger.info('[Coordinator] Cache invalidated', { userId });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  coordinate,
  getAgentStatus,
  invalidateUserCache,
  classifyIntent,
  INTENT_MAP,
};










