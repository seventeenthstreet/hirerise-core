'use strict';

/**
 * Career Advisor Engine (Supabase + AI Vector Enhanced)
 */

const crypto       = require('crypto');
const cacheManager = require('../core/cache/cache.manager');
const supabase     = require('../config/supabase');
const logger       = require('../utils/logger');
const { getUserVector } = require('../services/userVector.service'); // ✅ NEW

const CACHE_TTL_SECONDS = 600;

const MODEL       = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS  = 800;
const TEMPERATURE = 0.4;

const cache = cacheManager?.getClient?.();

// ─────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────

function getAnthropic() {
  return require('../config/anthropic.client');
}

// ─────────────────────────────────────────────
// Profile Hash
// ─────────────────────────────────────────────

function profileHash(profile) {
  return crypto
    .createHash('md5')
    .update(JSON.stringify({
      skills: (profile.skills || []).sort(),
      yearsExperience: profile.yearsExperience || 0,
      targetRole: profile.targetRole || '',
      industry: profile.industry || '',
    }))
    .digest('hex')
    .slice(0, 8);
}

// ─────────────────────────────────────────────
// Safe JSON Parse
// ─────────────────────────────────────────────

function safeParseJSON(text) {
  try {
    const clean = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Prompt Builder
// ─────────────────────────────────────────────

function buildPrompt({ profile, skillGap, marketDemand, topJobMatches, vectorMeta }) {
  const skills     = (profile.skills || []).join(', ') || 'not specified';
  const experience = profile.yearsExperience || 0;

  return `You are a senior career strategist specialising in the Indian job market.

USER PROFILE:
- Skills: ${skills}
- Experience: ${experience} years
- Target Role: ${profile.targetRole || 'not specified'}
- Industry: ${profile.industry || 'not specified'}

AI CONTEXT:
- User vector available: ${vectorMeta ? 'YES' : 'NO'}

SKILL GAP:
- Missing high-demand: ${(skillGap?.missing_high_demand || []).slice(0,5).join(', ') || 'none'}
- Adjacent: ${(skillGap?.adjacent_skills || []).slice(0,5).join(', ') || 'none'}

MARKET:
- Trending: ${(marketDemand?.trending || []).slice(0,3).join(', ') || 'n/a'}

JOBS:
- Matches: ${(topJobMatches || [])
  .slice(0,3)
  .map(j => `${j.title || j.role} (${j.match_score || j.matchScore}%)`)
  .join(', ') || 'none'}

Return STRICT JSON:
{
  "career_insight": "",
  "key_opportunity": "",
  "salary_potential": "",
  "timeline": "",
  "skills_to_prioritise": []
}`;
}

// ─────────────────────────────────────────────
// Main Engine
// ─────────────────────────────────────────────

async function generateCareerAdvice({
  userId,
  profile,
  skillGap,
  marketDemand,
  topJobMatches
}) {
  if (!userId || !profile) {
    throw new Error('userId and profile required');
  }

  const hash     = profileHash(profile);
  const cacheKey = `career:advice:${userId}`;

  // 🔥 NEW: get user vector (non-blocking safe usage)
  let userVector = null;
  try {
    userVector = await getUserVector(userId, profile.skills || []);
  } catch (err) {
    logger.warn('[CareerAdvisor] user vector fetch failed', {
      userId,
      err: err.message
    });
  }

  // ───────────── Redis Cache ─────────────

  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed._profile_hash === hash) {
          logger.debug('[CareerAdvisor] Redis hit', { userId });
          return parsed;
        }
      }
    } catch (err) {
      logger.warn('[Cache] Redis read failed', { err: err.message });
    }
  }

  // ───────────── Supabase Cache ─────────────

  try {
    const { data } = await supabase
      .from('career_advice_cache')
      .select('advice_text, profile_hash, expires_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (
      data &&
      data.profile_hash === hash &&
      (!data.expires_at || new Date(data.expires_at) > new Date())
    ) {
      const parsed = safeParseJSON(data.advice_text);
      if (parsed) {
        parsed._profile_hash = hash;

        if (cache) {
          await cache.set(cacheKey, JSON.stringify(parsed), 'EX', CACHE_TTL_SECONDS);
        }

        logger.debug('[CareerAdvisor] Supabase cache hit', { userId });
        return parsed;
      }
    }
  } catch (err) {
    logger.warn('[CareerAdvisor] Supabase cache read failed', {
      userId,
      err: err.message
    });
  }

  // ───────────── AI Generation ─────────────

  logger.info('[CareerAdvisor] Generating via Claude', { userId });

  let raw;
  try {
    const anthropic = getAnthropic();

    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages: [{
        role: 'user',
        content: buildPrompt({
          profile,
          skillGap,
          marketDemand,
          topJobMatches,
          vectorMeta: !!userVector // 🔥 NEW
        })
      }]
    });

    raw = res.content?.[0]?.text || '';
  } catch (err) {
    logger.error('[CareerAdvisor] Claude failed', { userId, err: err.message });
    return fallbackAdvice(profile);
  }

  const parsed = safeParseJSON(raw);
  if (!parsed) {
    logger.warn('[CareerAdvisor] Invalid JSON → fallback', { userId });
    return fallbackAdvice(profile);
  }

  const result = {
    ...parsed,
    _profile_hash: hash,
    generated_at: new Date().toISOString()
  };

  // ───────────── Cache Write ─────────────

  if (cache) {
    try {
      await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn('[Cache] Redis write failed', { err: err.message });
    }
  }

  // Fire-and-forget DB write
  supabase
    .from('career_advice_cache')
    .upsert({
      user_id: userId,
      advice_text: JSON.stringify(result),
      profile_hash: hash,
      expires_at: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString()
    }, { onConflict: 'user_id' })
    .then(() => {})
    .catch(() => {});

  logger.info('[CareerAdvisor] Advice generated', { userId });

  return result;
}

// ─────────────────────────────────────────────
// Fallback
// ─────────────────────────────────────────────

function fallbackAdvice(profile) {
  const skills = (profile.skills || []).slice(0, 3).join(', ') || 'your skills';

  return {
    career_insight: `Your experience with ${skills} gives you a solid base. Expanding into adjacent high-demand skills can significantly improve your career trajectory.`,
    key_opportunity: 'Focus on 2–3 in-demand skills aligned with your current role.',
    salary_potential: '20–40% growth possible',
    timeline: '6–18 months',
    skills_to_prioritise: [],
    _fallback: true,
    generated_at: new Date().toISOString()
  };
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  generateCareerAdvice
};