'use strict';

/**
 * aiPersonalization.engine.js — AI Personalization Engine
 *
 * Continuously personalizes career recommendations by learning from user
 * behavioral signals stored in user_behavior_events.
 *
 * ─── Architecture ─────────────────────────────────────────────────────────────
 *
 *   user_behavior_events (Supabase)
 *         ↓
 *   updateBehaviorProfile(userId)   — analyzes events, builds signal profile
 *         ↓
 *   user_personalization_profile (Supabase)
 *         ↓
 *   recommendPersonalizedCareers(userId)  — generates scored career list
 *         ↓
 *   personalized_recommendations (Supabase + Redis cache)
 *
 * ─── Scoring Model ────────────────────────────────────────────────────────────
 *
 *   personalization_score =
 *     0.40 × behavior_signals     — weighted event frequency + recency
 *     0.30 × skill_alignment      — overlap between behavior-derived skills and role
 *     0.20 × opportunity_score    — from career_opportunity_signals table
 *     0.10 × market_demand        — from LMI skill demand data
 *
 * ─── Integration Points (read-only from existing engines) ────────────────────
 *
 *   SkillGraphEngine     → getUserSkillGraph()  — for skill_alignment component
 *   OpportunityRadar     → career_opportunity_signals table — for opportunity_score
 *   JobMatchingEngine    → getJobMatches()       — baseline jobs to boost
 *   LaborMarketSvc       → getSkillDemand()      — market_demand component
 *
 * ─── Design Principles ───────────────────────────────────────────────────────
 *
 *   - NEVER modifies existing engines
 *   - Behavior profile is ADDITIVE signal layered on top of existing scoring
 *   - Graceful degradation: returns unmodified existing results if no signal
 *   - Cold start: new users with no events get baseline (existing engine output)
 *   - Privacy: only aggregated signals stored, not raw event sequences
 *
 * @module src/engines/aiPersonalization.engine
 */

const supabase       = require('../core/supabaseClient');
const cacheManager   = require('../core/cache/cache.manager');
const logger         = require('../utils/logger');
const { db }         = require('../config/supabase');

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 600;   // 10 minutes

// Personalization scoring weights (must sum to 1.0)
const P_WEIGHTS = Object.freeze({
  behavior_signals:  0.40,
  skill_alignment:   0.30,
  opportunity_score: 0.20,
  market_demand:     0.10,
});

// How many recent events to analyze for behavior profile
const ANALYSIS_WINDOW_DAYS = 30;
const MAX_EVENTS_PER_ANALYSIS = 500;

// Minimum events before personalization kicks in meaningfully
const MIN_EVENTS_FOR_SIGNAL = 3;

// Signal strength thresholds (total weighted events)
const SIGNAL_THRESHOLDS = [
  { min: 50, label: 'very_high' },
  { min: 25, label: 'high' },
  { min: 10, label: 'medium' },
  { min: 3,  label: 'low' },
  { min: 0,  label: 'none' },
];

// Event type weights — some interactions are stronger signals than others
const EVENT_WEIGHTS = Object.freeze({
  job_apply:              5.0,   // strongest signal — real intent
  job_click:              2.0,
  job_save:               2.5,
  opportunity_click:      2.0,
  career_path_view:       1.8,
  skill_view:             1.5,
  skill_search:           1.5,
  course_view:            1.3,
  learning_path_start:    2.0,
  role_explore:           1.5,
  advice_read:            1.0,
  dashboard_module_usage: 0.5,
  salary_check:           1.2,
});

// Recency decay: events are weighted by how recent they are
// Events in the last 7 days get 1.0x, 8–14 days 0.7x, 15–30 days 0.4x
function _recencyFactor(eventTimestamp) {
  const ageMs   = Date.now() - new Date(eventTimestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 7)  return 1.0;
  if (ageDays <= 14) return 0.7;
  return 0.4;
}

const cache = cacheManager.getClient();

// ─── Lazy engine loaders ──────────────────────────────────────────────────────

let _skillGraphSvc = null;
let _jobMatchSvc   = null;
let _marketSvc     = null;

function _getSkillGraphSvc() {
  if (!_skillGraphSvc) {
    try { _skillGraphSvc = require('../modules/jobSeeker/skillGraphEngine.service'); }
    catch (_) {}
  }
  return _skillGraphSvc;
}

function _getJobMatchSvc() {
  if (!_jobMatchSvc) {
    try { _jobMatchSvc = require('../modules/jobSeeker/jobMatchingEngine.service'); }
    catch (_) {}
  }
  return _jobMatchSvc;
}

function _getMarketSvc() {
  if (!_marketSvc) {
    try { _marketSvc = require('../modules/labor-market-intelligence/services/marketTrend.service'); }
    catch (_) {}
  }
  return _marketSvc;
}

// ─── Cache helper ─────────────────────────────────────────────────────────────

async function _cached(key, ttl, fn) {
  try {
    const hit = await cache.get(key);
    if (hit) return { ...JSON.parse(hit), _cached: true };
  } catch (_) {}
  const result = await fn();
  try { await cache.set(key, JSON.stringify(result), 'EX', ttl); } catch (_) {}
  return result;
}

// ─── Firestore profile loader ─────────────────────────────────────────────────

async function _loadFirestoreProfile(userId) {
  try {
    const [profileSnap, progressSnap] = await Promise.all([
      db.collection('userProfiles').doc(userId).get(),
      db.collection('onboardingProgress').doc(userId).get(),
    ]);
    const profile  = profileSnap.exists  ? profileSnap.data()  : {};
    const progress = progressSnap.exists ? progressSnap.data() : {};
    const rawSkills = (Array.isArray(profile.skills) && profile.skills.length > 0)
      ? profile.skills
      : (Array.isArray(progress.skills) ? progress.skills : []);
    return {
      skills:          rawSkills.map(s => (typeof s === 'string' ? s : s?.name)).filter(Boolean),
      targetRole:      profile.targetRole || profile.currentJobTitle || null,
      industry:        profile.industry   || null,
      yearsExperience: profile.experienceYears || profile.yearsExperience || 0,
    };
  } catch (_) {
    return { skills: [], targetRole: null, industry: null, yearsExperience: 0 };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// updateBehaviorProfile(userId)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Analyze user behavior events and update the personalization profile.
 *
 * Algorithm:
 *   1. Load recent events from user_behavior_events (last 30 days, max 500)
 *   2. For each event, compute weighted signal using event type weight × recency factor
 *   3. Aggregate signals per role, skill, industry, module
 *   4. Normalize to 0–1 scores
 *   5. Upsert to user_personalization_profile
 *
 * @param {string} userId
 * @returns {Promise<PersonalizationProfile>}
 */
async function updateBehaviorProfile(userId) {
  if (!userId) throw new Error('updateBehaviorProfile: userId required');

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - ANALYSIS_WINDOW_DAYS);

  // 1. Load raw events
  const { data: events, error } = await supabase
    .from('user_behavior_events')
    .select('event_type, entity_type, entity_id, entity_label, timestamp, metadata')
    .eq('user_id', userId)
    .gte('timestamp', windowStart.toISOString())
    .order('timestamp', { ascending: false })
    .limit(MAX_EVENTS_PER_ANALYSIS);

  if (error) {
    logger.error('[PersonalizationEngine] updateBehaviorProfile: event load failed', {
      userId, err: error.message,
    });
    throw new Error(`Failed to load behavior events: ${error.message}`);
  }

  if (!events || events.length === 0) {
    logger.info('[PersonalizationEngine] No events found — creating empty profile', { userId });
    return _upsertProfile(userId, {
      preferred_roles:      [],
      preferred_skills:     [],
      career_interests:     [],
      active_modules:       [],
      engagement_score:     0,
      total_events:         0,
      profile_completeness: 0,
      analyzed_from:        windowStart.toISOString(),
      analyzed_to:          new Date().toISOString(),
    });
  }

  // 2. Aggregate weighted signals
  const roleSignals    = new Map();  // role_name → { score, click_count, apply_count }
  const skillSignals   = new Map();  // skill_name → { score, view_count }
  const industryMap    = new Map();  // industry → score
  const moduleSet      = new Set();  // active module slugs
  let   totalWeight    = 0;

  for (const event of events) {
    const typeWeight    = EVENT_WEIGHTS[event.event_type] || 0.5;
    const recency       = _recencyFactor(event.timestamp);
    const eventScore    = typeWeight * recency;
    totalWeight        += eventScore;

    const label = event.entity_label || event.entity_id || 'unknown';

    if (event.entity_type === 'role' && event.entity_id) {
      const existing = roleSignals.get(label) || { score: 0, click_count: 0, apply_count: 0 };
      existing.score      += eventScore;
      existing.click_count += (event.event_type === 'job_click'  ? 1 : 0);
      existing.apply_count += (event.event_type === 'job_apply'  ? 1 : 0);
      roleSignals.set(label, existing);
    }

    if (event.entity_type === 'skill' && event.entity_id) {
      const existing = skillSignals.get(label) || { score: 0, view_count: 0 };
      existing.score      += eventScore;
      existing.view_count += 1;
      skillSignals.set(label, existing);
    }

    if (event.entity_type === 'module' && event.entity_id) {
      moduleSet.add(event.entity_id);
    }

    // Extract industry from metadata if present
    const industry = event.metadata?.industry;
    if (industry) {
      industryMap.set(industry, (industryMap.get(industry) || 0) + eventScore);
    }
  }

  // 3. Normalize scores to 0–1
  const maxRoleScore  = Math.max(...[...roleSignals.values()].map(v => v.score), 1);
  const maxSkillScore = Math.max(...[...skillSignals.values()].map(v => v.score), 1);
  const maxIndScore   = Math.max(...[...industryMap.values()], 1);

  const preferredRoles = [...roleSignals.entries()]
    .map(([name, data]) => ({
      name,
      score:       Math.round((data.score / maxRoleScore) * 100) / 100,
      click_count: data.click_count,
      apply_count: data.apply_count,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const preferredSkills = [...skillSignals.entries()]
    .map(([name, data]) => ({
      name,
      score:      Math.round((data.score / maxSkillScore) * 100) / 100,
      view_count: data.view_count,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  const careerInterests = [...industryMap.entries()]
    .map(([industry, score]) => ({
      industry,
      score: Math.round((score / maxIndScore) * 100) / 100,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // 4. Engagement score (normalized total weight)
  const engagementScore = Math.min(100, Math.round(totalWeight * 2));

  // 5. Profile completeness (how rich is the signal)
  const hasRoles    = preferredRoles.length  > 0 ? 25 : 0;
  const hasSkills   = preferredSkills.length > 0 ? 25 : 0;
  const hasIndustry = careerInterests.length > 0 ? 25 : 0;
  const hasModules  = moduleSet.size          > 0 ? 25 : 0;
  const completeness = hasRoles + hasSkills + hasIndustry + hasModules;

  const profile = {
    preferred_roles:      preferredRoles,
    preferred_skills:     preferredSkills,
    career_interests:     careerInterests,
    active_modules:       [...moduleSet],
    engagement_score:     engagementScore,
    total_events:         events.length,
    profile_completeness: completeness,
    analyzed_from:        windowStart.toISOString(),
    analyzed_to:          new Date().toISOString(),
  };

  logger.info('[PersonalizationEngine] Profile updated', {
    userId,
    total_events:    events.length,
    roles_detected:  preferredRoles.length,
    skills_detected: preferredSkills.length,
    engagement:      engagementScore,
  });

  return _upsertProfile(userId, profile);
}

// ─── _upsertProfile ───────────────────────────────────────────────────────────

async function _upsertProfile(userId, profile) {
  const { error } = await supabase
    .from('user_personalization_profile')
    .upsert({ user_id: userId, ...profile }, { onConflict: 'user_id' });

  if (error) {
    logger.error('[PersonalizationEngine] Profile upsert failed', {
      userId, err: error.message,
    });
  }

  // Invalidate recommendations cache when profile updates
  try { await cache.del(`personalization:recommendations:${userId}`); } catch (_) {}

  return { user_id: userId, ...profile };
}

// ═════════════════════════════════════════════════════════════════════════════
// recommendPersonalizedCareers(userId)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Generate personalized career recommendations using behavioral signals
 * layered over existing engine outputs.
 *
 * Steps:
 *   1. Load personalization profile (signal baseline)
 *   2. Load existing engine results (job matches, opportunity radar, skill graph)
 *   3. Score each candidate role using the 4-component personalization formula
 *   4. Sort, deduplicate, return top N
 *   5. Cache result for 10 minutes
 *
 * @param {string} userId
 * @param {{ topN?: number, forceRefresh?: boolean }} opts
 * @returns {Promise<PersonalizedRecommendationsResult>}
 */
async function recommendPersonalizedCareers(userId, opts = {}) {
  const { topN = 10, forceRefresh = false } = opts;
  const cacheKey = `personalization:recommendations:${userId}`;

  if (!forceRefresh) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        logger.debug('[PersonalizationEngine] Cache hit', { userId });
        return { ...JSON.parse(cached), _cached: true };
      }
    } catch (_) {}
  }

  // 1. Load personalization profile
  const { data: profileRow } = await supabase
    .from('user_personalization_profile')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const profile = profileRow || {
    preferred_roles:  [],
    preferred_skills: [],
    career_interests: [],
    engagement_score: 0,
    total_events:     0,
  };

  const hasSignal = profile.total_events >= MIN_EVENTS_FOR_SIGNAL;
  const signalStrength = _getSignalStrength(profile.engagement_score || 0, profile.total_events || 0);

  // 2. Load base data from existing engines (all in parallel)
  const [firestoreProfile, jobMatchResult, radarResult, skillGapResult, marketResult] =
    await Promise.allSettled([
      _loadFirestoreProfile(userId),
      _getJobMatchSvc() ? _getJobMatchSvc().getJobMatches(userId, { limit: 30 }) : Promise.resolve(null),
      _loadOpportunitySignals(),
      _getSkillGraphSvc() ? _getSkillGraphSvc().getUserSkillGraph(userId) : Promise.resolve(null),
      _getMarketSvc() ? _getMarketSvc().getSkillDemand(30) : Promise.resolve([]),
    ]);

  const userProfile      = firestoreProfile.status === 'fulfilled' ? firestoreProfile.value : { skills: [] };
  const jobMatches       = jobMatchResult.status   === 'fulfilled' ? jobMatchResult.value?.recommended_jobs || [] : [];
  const opportunitySignals = radarResult.status    === 'fulfilled' ? radarResult.value : [];
  const skillGraph       = skillGapResult.status   === 'fulfilled' ? skillGapResult.value : null;
  const marketDemand     = marketResult.status     === 'fulfilled' ? (marketResult.value || []) : [];

  // 3. Build candidate role pool from job matches + opportunity signals
  const candidateMap = new Map();  // role_name → candidate

  // Seed from job matches
  for (const job of jobMatches) {
    const roleName = job.title || job.role;
    if (!roleName) continue;
    if (!candidateMap.has(roleName)) {
      candidateMap.set(roleName, {
        role:             roleName,
        industry:         job.sector || job.industry || null,
        base_match_score: job.match_score || 0,
        opportunity_score: 0,
        market_demand:    0,
        average_salary:   job.salary?.max ? `₹${Math.round(job.salary.max/100000)}L` : null,
      });
    }
  }

  // Enrich with opportunity signals
  for (const signal of opportunitySignals) {
    if (!signal.role_name) continue;
    if (candidateMap.has(signal.role_name)) {
      candidateMap.get(signal.role_name).opportunity_score = signal.opportunity_score || 0;
      if (!candidateMap.get(signal.role_name).average_salary) {
        candidateMap.get(signal.role_name).average_salary = signal.average_salary || null;
      }
    } else {
      candidateMap.set(signal.role_name, {
        role:             signal.role_name,
        industry:         signal.industry  || null,
        base_match_score: 0,
        opportunity_score: signal.opportunity_score || 0,
        market_demand:    0,
        average_salary:   signal.average_salary || null,
      });
    }
  }

  // 4. Build market demand lookup
  const marketDemandMap = new Map(
    (marketDemand || []).map(s => [(s.skill_name || s.name || '').toLowerCase(), s.demand_score || 0])
  );

  // Derive market demand score for each candidate (average demand of role's required skills)
  // For simplicity, use opportunity signal's demand_score if available
  for (const signal of opportunitySignals) {
    const candidate = candidateMap.get(signal.role_name);
    if (candidate) {
      candidate.market_demand = signal.demand_score || 0;
    }
  }

  // 5. Score each candidate using personalization formula
  const userSkills    = new Set((userProfile.skills || []).map(s => s.toLowerCase()));
  const behaviorRoles = new Map(
    (profile.preferred_roles || []).map(r => [r.name.toLowerCase(), r.score])
  );
  const behaviorSkills = new Map(
    (profile.preferred_skills || []).map(s => [s.name.toLowerCase(), s.score])
  );

  const scored = [];

  for (const [roleName, candidate] of candidateMap) {
    // Component A: Behavior signal (0–100)
    const behaviorScore   = Math.round(
      (behaviorRoles.get(roleName.toLowerCase()) || 0) * 100
    );

    // Component B: Skill alignment (0–100)
    // = existing match score + behavior skill boost
    const existingMatchPct = candidate.base_match_score;
    const behaviorSkillBoost = [...behaviorSkills.entries()]
      .filter(([skill]) => _isRelevantToRole(skill, roleName))
      .reduce((sum, [, score]) => sum + score * 20, 0); // each relevant behavior skill adds up to 20 pts
    const skillAlignScore = Math.min(100, existingMatchPct + behaviorSkillBoost);

    // Component C: Opportunity score (already 0–100)
    const opportunityScore = candidate.opportunity_score || 0;

    // Component D: Market demand (0–100)
    const marketScore = candidate.market_demand || 0;

    // Personalization formula
    const rawScore =
      P_WEIGHTS.behavior_signals  * behaviorScore   +
      P_WEIGHTS.skill_alignment   * skillAlignScore +
      P_WEIGHTS.opportunity_score * opportunityScore +
      P_WEIGHTS.market_demand     * marketScore;

    // If no personalization signal, fall back to base match score
    const finalScore = hasSignal
      ? Math.round(Math.min(99, rawScore))
      : Math.round(Math.min(99, existingMatchPct * 0.6 + opportunityScore * 0.4));

    if (finalScore < 20) continue;  // filter noise

    // Build match reason string
    const matchReason = _buildMatchReason(
      behaviorScore, skillAlignScore, opportunityScore, profile, roleName
    );

    scored.push({
      role:             roleName,
      score:            finalScore / 100,  // normalise 0–99 → 0–1 to match frontend Math.round(r.score*100) display
      industry:         candidate.industry,
      average_salary:   candidate.average_salary,
      match_reason:     matchReason,
      breakdown: {
        behavior_signals:  Math.round(P_WEIGHTS.behavior_signals  * behaviorScore),
        skill_alignment:   Math.round(P_WEIGHTS.skill_alignment   * skillAlignScore),
        opportunity_score: Math.round(P_WEIGHTS.opportunity_score * opportunityScore),
        market_demand:     Math.round(P_WEIGHTS.market_demand     * marketScore),
      },
    });
  }

  // 6. Sort and return top N
  const topRoles = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  const result = {
    user_id:              userId,
    personalized_roles:   topRoles,
    personalization_score: topRoles.length > 0 ? topRoles[0].score : 0,
    signal_strength:      signalStrength,
    total_events_analyzed: profile.total_events || 0,
    profile_completeness:  profile.profile_completeness || 0,
    has_personalization:   hasSignal,
    score_breakdown:       {
      behavior_signals:   P_WEIGHTS.behavior_signals,
      skill_alignment:    P_WEIGHTS.skill_alignment,
      opportunity_score:  P_WEIGHTS.opportunity_score,
      market_demand:      P_WEIGHTS.market_demand,
    },
    generated_at: new Date().toISOString(),
  };

  // 7. Cache in Redis
  try { await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS); } catch (_) {}

  // 8. Persist to Supabase
  supabase.from('personalized_recommendations').upsert({
    user_id:              userId,
    personalized_roles:   topRoles,
    personalization_score: result.personalization_score,
    signal_strength:      signalStrength,
    score_breakdown:      result.score_breakdown,
    computed_at:          new Date().toISOString(),
    expires_at:           new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString(),
  }, { onConflict: 'user_id' }).then(() => {}).catch(() => {});

  return result;
}

// ─── trackBehaviorEvent ───────────────────────────────────────────────────────

/**
 * Record a single user behavior event.
 * Called by POST /api/user/behavior-event.
 *
 * Triggers an async profile update every PROFILE_UPDATE_INTERVAL events.
 *
 * @param {string} userId
 * @param {object} eventData
 * @returns {Promise<{ id: string, queued_profile_update: boolean }>}
 */
const PROFILE_UPDATE_INTERVAL = 5;  // update profile every 5 new events

async function trackBehaviorEvent(userId, eventData) {
  const {
    event_type,
    entity_type  = null,
    entity_id    = null,
    entity_label = null,
    metadata     = {},
    session_id   = null,
  } = eventData;

  if (!userId)     throw new Error('trackBehaviorEvent: userId required');
  if (!event_type) throw new Error('trackBehaviorEvent: event_type required');

  const { data, error } = await supabase
    .from('user_behavior_events')
    .insert({
      user_id:      userId,
      event_type,
      entity_type,
      entity_id,
      entity_label,
      metadata,
      session_id,
    })
    .select('id')
    .single();

  if (error) {
    logger.error('[PersonalizationEngine] trackBehaviorEvent insert failed', {
      userId, event_type, err: error.message,
    });
    throw new Error(`Failed to record behavior event: ${error.message}`);
  }

  // Check event count — trigger async profile update every N events
  let queuedProfileUpdate = false;
  try {
    const { count } = await supabase
      .from('user_behavior_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (count && count % PROFILE_UPDATE_INTERVAL === 0) {
      // Fire and forget — don't block the response
      setImmediate(() => {
        updateBehaviorProfile(userId).catch(err => {
          logger.warn('[PersonalizationEngine] Async profile update failed', {
            userId, err: err.message,
          });
        });
      });
      queuedProfileUpdate = true;
    }
  } catch (_) {}

  logger.debug('[PersonalizationEngine] Event tracked', {
    userId, event_type, entity_type, entity_id,
  });

  return { id: data.id, queued_profile_update: queuedProfileUpdate };
}

// ─── getPersonalizationProfile ────────────────────────────────────────────────

/**
 * Get the current personalization profile for a user.
 * Returns null if no profile exists yet.
 *
 * @param {string} userId
 * @returns {Promise<PersonalizationProfile|null>}
 */
async function getPersonalizationProfile(userId) {
  const cacheKey = `personalization:profile:${userId}`;

  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const { data } = await supabase
      .from('user_personalization_profile')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    return data;
  });
}

// ─── applyPersonalizationBoost ────────────────────────────────────────────────

/**
 * Apply personalization signals to an existing list of items (jobs, opportunities).
 * Items with entity names matching user's behavioral preferences get a score boost.
 *
 * Used by dashboard modules to re-rank their existing results.
 *
 * @param {string}   userId
 * @param {object[]} items     — array of items with { title|role|name } property
 * @param {string}   itemType  — 'job' | 'opportunity' | 'skill' | 'path'
 * @returns {Promise<object[]>}  — same items, sorted with personalization applied
 */
async function applyPersonalizationBoost(userId, items, itemType = 'job') {
  if (!items || items.length === 0) return items;

  const profile = await getPersonalizationProfile(userId);
  if (!profile || profile.total_events < MIN_EVENTS_FOR_SIGNAL) {
    return items;  // no signal — return untouched
  }

  const roleSignals  = new Map(
    (profile.preferred_roles  || []).map(r => [r.name.toLowerCase(), r.score])
  );
  const skillSignals = new Map(
    (profile.preferred_skills || []).map(s => [s.name.toLowerCase(), s.score])
  );

  return items
    .map(item => {
      const name = (item.title || item.role || item.name || '').toLowerCase();
      const roleBoost  = (roleSignals.get(name)  || 0) * 15;  // up to 15 point boost
      const skillBoost = (item.missing_skills || item.skills || [])
        .reduce((sum, skill) => sum + (skillSignals.get(skill.toLowerCase()) || 0) * 5, 0);

      return {
        ...item,
        _personalization_boost: Math.round(roleBoost + Math.min(10, skillBoost)),
        _personalized: true,
      };
    })
    .sort((a, b) => {
      const aScore = (a.match_score || a.opportunity_score || a.score || 0) + (a._personalization_boost || 0);
      const bScore = (b.match_score || b.opportunity_score || b.score || 0) + (b._personalization_boost || 0);
      return bScore - aScore;
    });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _loadOpportunitySignals() {
  const { data } = await supabase
    .from('career_opportunity_signals')
    .select('role_name, industry, opportunity_score, demand_score, average_salary, required_skills')
    .gte('opportunity_score', 40)
    .order('opportunity_score', { ascending: false })
    .limit(30);
  return data || [];
}

function _getSignalStrength(engagementScore, totalEvents) {
  if (totalEvents === 0) return 'none';
  const combined = engagementScore + totalEvents * 2;
  for (const { min, label } of SIGNAL_THRESHOLDS) {
    if (combined >= min) return label;
  }
  return 'none';
}

function _isRelevantToRole(skillName, roleName) {
  // Simple heuristic: check if skill keywords appear in role name or are commonly associated
  const roleNorm  = roleName.toLowerCase();
  const skillNorm = skillName.toLowerCase();
  if (roleNorm.includes(skillNorm) || skillNorm.includes(roleNorm)) return true;
  // Domain matches
  const dataSkills = ['sql', 'python', 'power bi', 'excel', 'tableau', 'data'];
  const dataRoles  = ['analyst', 'data', 'business intelligence', 'bi'];
  if (dataSkills.some(s => skillNorm.includes(s)) && dataRoles.some(r => roleNorm.includes(r))) return true;
  return false;
}

function _buildMatchReason(behaviorScore, skillScore, opportunityScore, profile, roleName) {
  const parts = [];
  if (behaviorScore > 50) parts.push(`frequently viewed ${roleName} roles`);
  else if (behaviorScore > 20) parts.push(`showed interest in ${roleName}`);
  if (skillScore > 60)    parts.push('strong skill alignment');
  if (opportunityScore > 70) parts.push('high market opportunity');
  if (parts.length === 0) return 'Based on your profile and market trends';
  return `Matches because you ${parts.join(', and ')}`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  updateBehaviorProfile,
  recommendPersonalizedCareers,
  trackBehaviorEvent,
  getPersonalizationProfile,
  applyPersonalizationBoost,
  P_WEIGHTS,
  EVENT_WEIGHTS,
};








