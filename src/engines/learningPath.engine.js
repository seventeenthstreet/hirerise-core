'use strict';

/**
 * Learning Path Engine v3 (AI + Supabase + Cost Optimized + Vector Integrated)
 */

const cacheManager = require('../core/cache/cache.manager');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const { getUserVector } = require('../services/userVector.service'); // ✅ NEW

const CACHE_TTL = 600;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

const cache = cacheManager?.getClient?.();

function getAnthropic() {
  return require('../config/anthropic.client');
}

// ─────────────────────────────────────────────
// SAFE JSON PARSE
// ─────────────────────────────────────────────

function safeParse(text) {
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
// MAIN ENGINE
// ─────────────────────────────────────────────

async function generateLearningPath({ skill, userSkills = [], targetRole = '', userId }) {
  if (!skill) throw new Error('skill required');

  const cacheKey = `learning:path:${userId || 'anon'}:${skill.toLowerCase()}`; // ✅ improved

  // 🔹 Redis cache
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  // 🔥 NEW: get user vector (non-blocking safe)
  let userVector = null;
  try {
    if (userId) {
      userVector = await getUserVector(userId, userSkills);
    }
  } catch (err) {
    logger.warn('[LearningPath] user vector fetch failed', {
      userId,
      err: err.message
    });
  }

  // 🔹 Supabase cache
  try {
    const { data } = await supabase
      .from('learning_paths_cache')
      .select('path')
      .eq('skill', skill)
      .maybeSingle();

    if (data?.path) {
      if (cache) {
        await cache.set(cacheKey, JSON.stringify(data.path), 'EX', CACHE_TTL);
      }
      return data.path;
    }
  } catch (_) {}

  // 🔹 AI GENERATION
  logger.info('[LearningPath] Generating via AI', { skill });

  let aiResult = null;

  try {
    const anthropic = getAnthropic();

    const prompt = `Generate a structured learning path for skill: ${skill}.

USER CONTEXT:
- Existing skills: ${userSkills.join(', ') || 'none'}
- Target role: ${targetRole || 'not specified'}
- AI vector available: ${userVector ? 'YES' : 'NO'}

Return strict JSON with steps, duration, and outcome.`;

    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }]
    });

    aiResult = safeParse(res.content?.[0]?.text || '');
  } catch (err) {
    logger.warn('[LearningPath] AI failed', { err: err.message });
  }

  if (!aiResult) {
    return fallback(skill);
  }

  const result = {
    ...aiResult,
    generated_at: new Date().toISOString(),

    // 🔥 NEW META
    vector_used: !!userVector
  };

  // 🔹 Cache write
  if (cache) {
    await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
  }

  // 🔹 Save to Supabase (async)
  supabase
    .from('learning_paths_cache')
    .upsert({
      skill,
      path: result,
      updated_at: new Date().toISOString()
    }, { onConflict: 'skill' })
    .then(() => {})
    .catch(() => {});

  return result;
}

// ─────────────────────────────────────────────
// MULTI SKILL
// ─────────────────────────────────────────────

async function generateMultiSkillPaths({ skills, userId, userSkills = [], targetRole = '' }) {
  const results = await Promise.all(
    skills.slice(0, 8).map(skill =>
      generateLearningPath({
        skill,
        userId,
        userSkills,
        targetRole
      })
    )
  );

  return {
    learning_paths: results,
    total: results.length
  };
}

// ─────────────────────────────────────────────
// FALLBACK
// ─────────────────────────────────────────────

function fallback(skill) {
  return {
    skill,
    steps: [
      { step: 1, title: `${skill} Basics` },
      { step: 2, title: `${skill} Practice` },
      { step: 3, title: `${skill} Advanced` }
    ],
    outcome: `Proficiency in ${skill}`,
    _fallback: true
  };
}

module.exports = {
  generateLearningPath,
  generateMultiSkillPaths
};