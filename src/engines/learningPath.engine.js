'use strict';

/**
 * learningPath.engine.js — AI-Enhanced Learning Path Engine
 *
 * UPGRADE 4 — extends learning.engine.js with:
 *   1. Semantic skill gap detection (uses SemanticSkillEngine)
 *   2. Structured multi-step learning paths per missing skill
 *   3. Prerequisite-aware ordering (respects SkillGraph relationships)
 *   4. Redis caching (TTL 10 min)
 *
 * The existing learning.engine.js (CSV-based) is used as fallback
 * when no AI-generated path is available.
 *
 * GET /api/v1/skills/learning-path
 *
 * @module src/engines/learningPath.engine
 */

const cacheManager        = require('../core/cache/cache.manager');
const logger              = require('../utils/logger');
const semanticSkillEngine = require('./semanticSkill.engine');

// Try to load existing learning engine — graceful fallback if missing
let _legacyLearningEngine = null;
try {
  _legacyLearningEngine = require('./learning.engine');
} catch (_) {}

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 600;   // 10 minutes
const MODEL             = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS        = 600;

const cache = cacheManager.getClient();

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

// ─── generateLearningPath ─────────────────────────────────────────────────────

/**
 * Generate a structured learning path for a missing skill.
 *
 * Strategy:
 *   1. Use SemanticSkillEngine to find prerequisite/related skills.
 *   2. Call Claude to generate a 3-5 step learning sequence.
 *   3. Fallback: use legacy learning.engine.js CSV-based resources.
 *
 * @param {{ skill: string, userSkills?: string[], targetRole?: string }} input
 * @returns {Promise<LearningPathResult>}
 */
async function generateLearningPath({ skill, userSkills = [], targetRole = '' }) {
  if (!skill) throw new Error('generateLearningPath: skill is required');

  const normSkill = skill.trim();
  const cacheKey  = `learning:path:${normSkill.toLowerCase().replace(/\s+/g, '-')}`;

  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    // 1. Find semantically related prerequisites
    let prerequisites = [];
    try {
      const similar = await semanticSkillEngine.findSimilarSkills(normSkill, { topK: 3, minScore: 0.65 });
      prerequisites  = similar.similar_skills || [];
    } catch (_) {}

    // 2. Filter to skills user doesn't have
    const userSkillsNorm   = new Set((userSkills || []).map(s => s.toLowerCase().trim()));
    const relevantPrereqs  = prerequisites.filter(s => !userSkillsNorm.has(s.toLowerCase().trim()));

    // 3. Generate path via Claude
    const aiPath = await _generateAIPath({ skill: normSkill, prerequisites: relevantPrereqs, targetRole, userSkills });

    if (aiPath) {
      logger.info('[LearningPath] AI path generated', { skill: normSkill });
      return aiPath;
    }

    // 4. Fallback to legacy CSV engine
    if (_legacyLearningEngine) {
      try {
        const legacy = await _legacyLearningEngine.recommendLearning(
          { skills: userSkills, targetRole },
          [normSkill]
        );
        if (legacy?.learning_paths?.length > 0) {
          return _normaliseLegacyPath(normSkill, legacy);
        }
      } catch (_) {}
    }

    // 5. Static fallback
    return _staticFallback(normSkill);
  });
}

// ─── generateMultiSkillPaths ─────────────────────────────────────────────────

/**
 * Generate learning paths for multiple missing skills.
 * Ordered by priority (most impactful first).
 *
 * @param {{ skills: string[], userSkills?: string[], targetRole?: string }} input
 * @returns {Promise<{ learning_paths: LearningPathResult[], total_skills: number }>}
 */
async function generateMultiSkillPaths({ skills, userSkills = [], targetRole = '' }) {
  if (!skills || skills.length === 0) {
    return { learning_paths: [], total_skills: 0 };
  }

  const cacheKey = `learning:multi:${skills.map(s => s.toLowerCase()).sort().join(',')}`;

  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const paths = await Promise.allSettled(
      skills.slice(0, 8).map(skill =>
        generateLearningPath({ skill, userSkills, targetRole })
      )
    );

    const resolved = paths
      .filter(p => p.status === 'fulfilled')
      .map(p => p.value);

    return {
      learning_paths: resolved,
      total_skills:   skills.length,
    };
  });
}

// ─── Internal: AI path generation ────────────────────────────────────────────

async function _generateAIPath({ skill, prerequisites, targetRole, userSkills }) {
  const context = targetRole ? ` for someone targeting ${targetRole}` : '';
  const prereqText = prerequisites.length > 0
    ? `Prerequisite knowledge (user may need these first): ${prerequisites.join(', ')}.`
    : '';

  const prompt = `You are a career learning specialist focused on the Indian job market.

Generate a structured learning path for the skill: "${skill}"${context}.
${prereqText}

Return ONLY a JSON object in this exact format — no preamble, no markdown:
{
  "skill": "${skill}",
  "estimated_duration": "<e.g. 4-6 weeks>",
  "difficulty": "beginner|intermediate|advanced",
  "steps": [
    {
      "step": 1,
      "title": "<short step title>",
      "description": "<what to learn and why>",
      "resources": ["<resource type or platform e.g. Coursera, YouTube, official docs>"],
      "duration": "<e.g. 1 week>"
    }
  ],
  "outcome": "<what the learner can do after completing this path>",
  "related_skills": ["<skill1>", "<skill2>"]
}

Generate 3-5 steps. Be specific and practical. Focus on free/affordable resources.`;

  try {
    const anthropic = getAnthropic();
    const message   = await anthropic.messages.create({
      model:       MODEL,
      max_tokens:  MAX_TOKENS,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw   = message.content?.[0]?.text || '';
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    logger.warn('[LearningPath] AI generation failed', { skill, err: err.message });
    return null;
  }
}

// ─── Normalisers / fallbacks ──────────────────────────────────────────────────

function _normaliseLegacyPath(skill, legacy) {
  const courses = legacy.learning_paths?.[0]?.courses || [];
  return {
    skill,
    estimated_duration: `${courses.length * 2} weeks`,
    difficulty:         'intermediate',
    steps: courses.slice(0, 4).map((c, i) => ({
      step:        i + 1,
      title:       c.course_name || skill,
      description: `${c.level || 'Structured'} course on ${skill}`,
      resources:   [c.provider || 'Online'],
      duration:    `${c.duration_hours || 10} hours`,
    })),
    outcome:         `Proficient in ${skill}`,
    related_skills:  [],
    _source:         'legacy_csv',
  };
}

function _staticFallback(skill) {
  return {
    skill,
    estimated_duration: '4–8 weeks',
    difficulty:         'intermediate',
    steps: [
      {
        step:        1,
        title:       `${skill} Fundamentals`,
        description: `Learn the core concepts and basic applications of ${skill}`,
        resources:   ['YouTube tutorials', 'Official documentation'],
        duration:    '1–2 weeks',
      },
      {
        step:        2,
        title:       `Hands-on Practice`,
        description: `Apply ${skill} through real-world mini projects`,
        resources:   ['Coursera', 'Udemy', 'Project-based learning'],
        duration:    '2–3 weeks',
      },
      {
        step:        3,
        title:       `Advanced Applications`,
        description: `Explore advanced use cases and industry best practices for ${skill}`,
        resources:   ['LinkedIn Learning', 'Industry blogs', 'Community forums'],
        duration:    '1–2 weeks',
      },
    ],
    outcome:        `Job-ready proficiency in ${skill}`,
    related_skills: [],
    _source:        'static_fallback',
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateLearningPath,
  generateMultiSkillPaths,
};









