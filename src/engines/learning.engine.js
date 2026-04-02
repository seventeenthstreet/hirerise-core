'use strict';

/**
 * Learning Engine v3 (Production Ready + Vector Integrated)
 */

const { supabase } = require('../config/supabase');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');
const { getUserVector } = require('../services/userVector.service'); // ✅ NEW

const cache = cacheManager?.getClient?.();
const CACHE_TTL = 600;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function normalize(str) {
  return (str || '').toLowerCase().trim();
}

function scoreCourse(level, duration) {
  const levelScore =
    level === 'Beginner' ? 1 :
    level === 'Intermediate' ? 2 :
    3;

  return levelScore * 2 - (duration || 0) / 50;
}

// Stable cache key (sorted + normalized + user aware)
function buildCacheKey(skills, userId) {
  return `learning:${userId || 'anon'}:${skills
    .map(normalize)
    .sort()
    .join('|')}`;
}

// ─────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────

async function recommendLearning(userProfile, skillGaps) {
  try {
    const { userId, skills: userSkills = [] } = userProfile || {};

    // Normalize input skills
    const skills = Array.isArray(skillGaps)
      ? skillGaps
          .map(s => typeof s === 'string' ? s : s?.skill_name)
          .filter(Boolean)
          .map(normalize)
      : [];

    if (!skills.length) {
      return {
        learning_recommendations: [],
        summary: {},
        meta: { error: 'no skill gaps' }
      };
    }

    const cacheKey = buildCacheKey(skills, userId);

    // ───────────── Redis Cache ─────────────
    if (cache) {
      try {
        const cached = await cache.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (err) {
        logger.warn('[Learning] Redis read failed', { err: err.message });
      }
    }

    // 🔥 NEW: Get user vector (non-blocking safe)
    let userVector = null;
    try {
      if (userId) {
        userVector = await getUserVector(userId, userSkills);
      }
    } catch (err) {
      logger.warn('[Learning] user vector fetch failed', {
        userId,
        err: err.message
      });
    }

    // ───────────── Supabase Query ─────────────
    let data = [];

    try {
      const res = await supabase
        .from('learning_resources')
        .select('*');

      if (res.error) throw res.error;

      // Normalize DB data for matching
      data = (res.data || []).filter(c =>
        skills.includes(normalize(c.skill))
      );

    } catch (err) {
      logger.error('[Learning] Supabase fetch failed', {
        err: err.message
      });

      return {
        learning_recommendations: [],
        summary: { message: 'database error' },
        meta: { error: 'db_failed' }
      };
    }

    if (!data.length) {
      return {
        learning_recommendations: [],
        summary: { message: 'No courses found' },
        meta: {}
      };
    }

    // ───────────── Grouping ─────────────
    const grouped = {};

    for (const course of data) {
      const key = normalize(course.skill);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(course);
    }

    // ───────────── Ranking ─────────────
    const recommendations = Object.entries(grouped).map(([skill, courses]) => {
      const ranked = courses
        .map(c => ({
          ...c,
          score: scoreCourse(c.level, c.duration_hours)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      // 🔥 OPTIONAL VECTOR BOOST (non-breaking)
      if (userVector) {
        ranked.forEach(r => {
          r.score += 0.01;
        });
      }

      return {
        skill,
        courses: ranked.map(c => ({
          course_name: c.course_name,
          provider: c.provider,
          level: c.level,
          duration_hours: c.duration_hours,
          url: c.url
        }))
      };
    });

    const response = {
      learning_recommendations: recommendations,
      summary: {
        skills_covered: recommendations.length,
        total_courses: recommendations.reduce((sum, r) => sum + r.courses.length, 0)
      },
      meta: {
        engine: 'learning-v3-production',
        generated_at: new Date().toISOString(),

        // 🔥 NEW AI META
        vector_used: !!userVector
      }
    };

    // ───────────── Cache Write ─────────────
    if (cache) {
      try {
        await cache.set(cacheKey, JSON.stringify(response), 'EX', CACHE_TTL);
      } catch (err) {
        logger.warn('[Learning] Redis write failed', { err: err.message });
      }
    }

    return response;

  } catch (err) {
    logger.error('[Learning] Unexpected failure', {
      err: err.message
    });

    return {
      learning_recommendations: [],
      summary: { message: 'internal error' },
      meta: { error: 'internal_error' }
    };
  }
}

module.exports = {
  recommendLearning
};