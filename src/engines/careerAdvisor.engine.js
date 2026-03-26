'use strict';

/**
 * careerAdvisor.engine.js — AI Career Advisor Engine
 *
 * UPGRADE 3 — generates personalised career insights using:
 *   - User profile (skills, experience, industry, target role)
 *   - Skill graph (adjacent, missing, high-demand skills)
 *   - Labor market intelligence (market demand trends)
 *   - Semantic job match scores (best-fit roles)
 *
 * Uses Anthropic Claude (existing circuit-breaker infrastructure) to
 * generate a structured career insight object.
 *
 * Caching:
 *   - Redis key  : career:advice:<userId>
 *   - TTL        : 10 minutes (CACHE_TTL_SECONDS)
 *   - Invalidated when profile hash changes (MD5 of skills + experience)
 *
 * Integration:
 *   Route: GET /api/v1/career/advice
 *   Called by: careerAdvisor.controller.js (new file — see routes)
 *
 * @module src/engines/careerAdvisor.engine
 */

const crypto       = require('crypto');
const cacheManager = require('../core/cache/cache.manager');
const supabase     = require('../core/supabaseClient');
const logger       = require('../utils/logger');

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 600;   // 10 minutes
const MODEL             = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS        = 800;
const TEMPERATURE       = 0.4;

const cache = cacheManager.getClient();

// ─── Anthropic client (reuses existing circuit-breaker registry) ──────────────

function getAnthropic() {
  return require('../config/anthropic.client');
}

// ─── Cache wrapper ────────────────────────────────────────────────────────────

async function _cached(key, ttl, fn) {
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (_) {}

  const result = await fn();

  try {
    await cache.set(key, JSON.stringify(result), 'EX', ttl);
  } catch (_) {}

  return result;
}

// ─── Profile hash ─────────────────────────────────────────────────────────────

/**
 * Generate a short hash of the user profile snapshot.
 * Used to detect stale cached advice.
 */
function _profileHash(profile) {
  const payload = JSON.stringify({
    skills:          (profile.skills || []).sort(),
    yearsExperience: profile.yearsExperience || 0,
    targetRole:      profile.targetRole || '',
    industry:        profile.industry || '',
  });
  return crypto.createHash('md5').update(payload).digest('hex').slice(0, 8);
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function _buildPrompt({ profile, skillGap, marketDemand, topJobMatches }) {
  const skills          = (profile.skills || []).join(', ') || 'not specified';
  const targetRole      = profile.targetRole || 'not specified';
  const industry        = profile.industry   || 'not specified';
  const experience      = profile.yearsExperience || 0;

  const missingSkills   = (skillGap?.missing_high_demand || [])
    .slice(0, 5)
    .map(s => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean)
    .join(', ') || 'none identified';

  const adjacentSkills  = (skillGap?.adjacent_skills || []).slice(0, 5).join(', ') || 'none';

  const topJobs         = (topJobMatches || [])
    .slice(0, 3)
    .map(j => `${j.title || j.role} (${j.match_score || j.matchScore}% match)`)
    .join(', ') || 'no matches yet';

  const demandSnippet   = (marketDemand?.trending || []).slice(0, 3).join(', ') || 'unavailable';

  return `You are a senior career strategist specialising in the Indian job market.

USER PROFILE:
- Current skills: ${skills}
- Experience: ${experience} years
- Target role: ${targetRole}
- Industry: ${industry}

SKILL INTELLIGENCE:
- High-demand skills they are missing: ${missingSkills}
- Adjacent skills they could learn next: ${adjacentSkills}

JOB MARKET DATA:
- Trending skills in market: ${demandSnippet}
- Top job matches: ${topJobs}

Generate a personalised career insight for this user. Be specific, actionable, and encouraging.
Focus on realistic 1-3 year opportunities.
Mention approximate salary upside if skill gaps are addressed (use Indian market rates).

Respond ONLY with a JSON object in this exact format — no preamble, no markdown:
{
  "career_insight": "<2-3 sentence personalised insight>",
  "key_opportunity": "<single most important next step>",
  "salary_potential": "<salary range after skill upgrade, e.g. ₹8–12 LPA>",
  "timeline": "<realistic timeline e.g. 6–18 months>",
  "skills_to_prioritise": ["skill1", "skill2", "skill3"]
}`;
}

// ─── generateCareerAdvice ─────────────────────────────────────────────────────

/**
 * Generate AI-powered career advice for a user.
 *
 * @param {{ user_id: string, profile: object, skillGap?: object, marketDemand?: object, topJobMatches?: object[] }} input
 * @returns {Promise<CareerAdviceResult>}
 */
async function generateCareerAdvice({ userId, profile, skillGap, marketDemand, topJobMatches }) {
  if (!userId || !profile) {
    throw new Error('generateCareerAdvice: userId and profile are required');
  }

  const hash     = _profileHash(profile);
  const cacheKey = `career:advice:${userId}`;

  // Check Redis
  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Invalidate if profile changed
      if (parsed._profile_hash === hash) {
        logger.debug('[CareerAdvisor] cache hit', { userId });
        return parsed;
      }
    }
  } catch (_) {}

  // Check Supabase persistent cache
  const { data: dbCache } = await supabase
    .from('career_advice_cache')
    .select('advice_text, profile_hash, expires_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (dbCache && dbCache.profile_hash === hash && new Date(dbCache.expires_at) > new Date()) {
    try {
      const parsed = JSON.parse(dbCache.advice_text);
      parsed._profile_hash = hash;
      await cache.set(cacheKey, JSON.stringify(parsed), 'EX', CACHE_TTL_SECONDS);
      return parsed;
    } catch (_) {}
  }

  // Generate via Claude
  logger.info('[CareerAdvisor] generating advice via Claude', { userId });

  const anthropic = getAnthropic();
  const prompt    = _buildPrompt({ profile, skillGap, marketDemand, topJobMatches });

  let rawResponse;
  try {
    const message = await anthropic.messages.create({
      model:       MODEL,
      max_tokens:  MAX_TOKENS,
      temperature: TEMPERATURE,
      messages: [{ role: 'user', content: prompt }],
    });
    rawResponse = message.content?.[0]?.text || '';
  } catch (err) {
    logger.error('[CareerAdvisor] Claude call failed', { userId, err: err.message });
    // Fallback response
    return _fallbackAdvice(profile);
  }

  // Parse JSON response
  let advice;
  try {
    const clean = rawResponse
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    advice = JSON.parse(clean);
  } catch (_) {
    logger.warn('[CareerAdvisor] failed to parse Claude JSON, using fallback', { userId });
    return _fallbackAdvice(profile);
  }

  const result = {
    ...advice,
    _profile_hash: hash,
    generated_at:  new Date().toISOString(),
  };

  // Cache in Redis
  try { await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS); } catch (_) {}

  // Persist to Supabase
  supabase.from('career_advice_cache').upsert({
    user_id:       userId,
    advice_text:   JSON.stringify(result),
    profile_hash:  hash,
  }, { onConflict: 'user_id' }).then(() => {}).catch(() => {});

  logger.info('[CareerAdvisor] advice generated and cached', { userId });
  return result;
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function _fallbackAdvice(profile) {
  const skills = (profile.skills || []).slice(0, 3).join(', ') || 'your current skills';
  return {
    career_insight:        `Your profile with ${skills} shows a strong foundation. Continue building domain expertise and adding complementary technical skills to increase your market value.`,
    key_opportunity:       'Identify 2-3 high-demand skills adjacent to your current expertise and pursue structured learning over the next 6 months.',
    salary_potential:      'Potential salary improvement of 20–40% after targeted upskilling',
    timeline:              '6–18 months',
    skills_to_prioritise:  [],
    _fallback:             true,
    generated_at:          new Date().toISOString(),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateCareerAdvice,
};









