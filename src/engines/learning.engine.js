'use strict';

/**
 * learning.engine.js — Standalone Learning Recommendation Engine
 *
 * Recommends courses and learning resources for a given list of skill gaps,
 * using /data/learning-resources.csv as the primary data source.
 *
 * This engine is designed to operate independently (CSV-only) while also
 * supporting optional enrichment from Firestore skill metadata when available.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   recommendLearning(userProfile, skillGaps)
 *     → LearningRecommendationResult
 *
 * ─── Integration Points ───────────────────────────────────────────────────────
 *
 *   Called by:
 *     - POST /api/v1/learning/recommendations  (standalone route)
 *     - chiV2 intelligenceOrchestrator         (full-intelligence endpoint)
 *     - chiV2 skillGap endpoint                (enriched skill-gap response)
 *
 * ─── Scoring Logic ────────────────────────────────────────────────────────────
 *
 *   Courses per skill are ranked by level:
 *     Beginner (1) → Intermediate (2) → Advanced (3)
 *
 *   Within the same level, shorter courses rank higher (faster to complete).
 *
 * ─── Caching ──────────────────────────────────────────────────────────────────
 *
 *   CSV dataset is loaded once and cached in-memory with a configurable TTL
 *   (default 1 hour). Call invalidateCache() to force a reload.
 *
 * SECURITY: Read-only. No writes. No auth mutations. No secrets.
 *
 * @module engines/learning.engine
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const logger   = require('../utils/logger');

// ─── Config ───────────────────────────────────────────────────────────────────

const CSV_PATH     = path.resolve(__dirname, '../data/learning-resources.csv');
const CACHE_TTL_MS = parseInt(process.env.LEARNING_CACHE_TTL_MS || '3600000', 10);

// Maximum courses returned per skill gap
const MAX_COURSES_PER_SKILL = parseInt(process.env.LEARNING_MAX_COURSES_PER_SKILL || '3', 10);

// Level ordering for sort
const LEVEL_ORDER = Object.freeze({
  beginner:     1,
  intermediate: 2,
  advanced:     3,
});

// ─── In-memory cache ──────────────────────────────────────────────────────────

const _cache = {
  /** @type {Map<string, CourseRecord[]> | null}  normalised_skill → courses */
  bySkill:  null,
  loadedAt: null,
};

// ─── CSV Loader ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CourseRecord
 * @property {string} skill
 * @property {string} course_name
 * @property {string} provider
 * @property {string} level         — 'Beginner' | 'Intermediate' | 'Advanced'
 * @property {number} duration_hours
 * @property {string} url
 */

/**
 * Load and cache learning-resources.csv into a Map keyed by normalised skill name.
 * Gracefully returns an empty Map if the file is missing.
 *
 * @returns {Promise<Map<string, CourseRecord[]>>}
 */
async function _loadCSV() {
  const now = Date.now();

  if (_cache.bySkill && _cache.loadedAt && (now - _cache.loadedAt < CACHE_TTL_MS)) {
    return _cache.bySkill;
  }

  if (!fs.existsSync(CSV_PATH)) {
    logger.warn('[LearningEngine] learning-resources.csv not found at', CSV_PATH);
    _cache.bySkill  = new Map();
    _cache.loadedAt = now;
    return _cache.bySkill;
  }

  const bySkill = await new Promise((resolve) => {
    const map     = new Map();
    let   headers = null;

    const rl = readline.createInterface({
      input:     fs.createReadStream(CSV_PATH, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (raw) => {
      const line = raw.trim();
      if (!line) return;

      const fields = _splitCSVLine(line);

      if (!headers) {
        headers = fields.map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
        return;
      }

      const row = {};
      headers.forEach((key, i) => { row[key] = (fields[i] ?? '').trim().replace(/^"|"$/g, ''); });

      if (!row.skill || !row.course_name) return;

      const normSkill = _norm(row.skill);

      const record = {
        skill:          row.skill,
        course_name:    row.course_name,
        provider:       row.provider       || 'Unknown',
        level:          _normaliseLevel(row.level),
        duration_hours: parseFloat(row.duration_hours) || 0,
        url:            row.url            || '',
      };

      if (!map.has(normSkill)) map.set(normSkill, []);
      map.get(normSkill).push(record);
    });

    rl.on('close', () => resolve(map));
    rl.on('error', (err) => {
      logger.error('[LearningEngine] CSV read error:', err.message);
      resolve(new Map());
    });
  });

  // Sort each skill's courses: Beginner → Intermediate → Advanced,
  // then by duration_hours asc within same level (shorter = faster win)
  for (const [, courses] of bySkill) {
    courses.sort((a, b) => {
      const levelDiff = (LEVEL_ORDER[a.level.toLowerCase()] || 2) -
                        (LEVEL_ORDER[b.level.toLowerCase()] || 2);
      if (levelDiff !== 0) return levelDiff;
      return (a.duration_hours || 0) - (b.duration_hours || 0);
    });
  }

  _cache.bySkill  = bySkill;
  _cache.loadedAt = now;

  logger.info('[LearningEngine] CSV loaded', {
    skills:  bySkill.size,
    courses: [...bySkill.values()].reduce((s, c) => s + c.length, 0),
  });

  return bySkill;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _norm(str) {
  return (str || '').toLowerCase().trim();
}

function _normaliseLevel(raw) {
  const s = _norm(raw);
  if (s === 'beginner')     return 'Beginner';
  if (s === 'intermediate') return 'Intermediate';
  if (s === 'advanced')     return 'Advanced';
  return 'Beginner'; // safe default
}

/**
 * Split a CSV line, respecting double-quoted fields containing commas.
 * @param {string} line
 * @returns {string[]}
 */
function _splitCSVLine(line) {
  const fields = [];
  let   current  = '';
  let   inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Find matching courses for a single skill.
 * Tries exact match first; falls back to partial keyword match.
 *
 * @param {Map<string, CourseRecord[]>} bySkill
 * @param {string} skillName
 * @returns {CourseRecord[]}
 */
function _findCourses(bySkill, skillName) {
  const normSkill = _norm(skillName);

  // 1. Exact normalised match
  if (bySkill.has(normSkill)) {
    return bySkill.get(normSkill);
  }

  // 2. Partial key match — skill name contains a dataset key or vice versa
  for (const [key, courses] of bySkill.entries()) {
    if (key.includes(normSkill) || normSkill.includes(key)) {
      return courses;
    }
  }

  return [];
}

/**
 * Estimate total learning time from a recommendation set.
 *
 * @param {Object[]} recommendations
 * @returns {{ total_hours: number, estimated_weeks: number, estimated_months: number }}
 */
function _estimateLearningTime(recommendations) {
  let total_hours = 0;

  for (const rec of recommendations) {
    const topCourse = rec.courses[0];
    if (topCourse?.duration_hours) {
      total_hours += topCourse.duration_hours;
    }
  }

  // Assuming 10 hours of learning per week
  const estimated_weeks  = Math.ceil(total_hours / 10);
  const estimated_months = Math.ceil(estimated_weeks / 4);

  return {
    total_hours:       Math.round(total_hours),
    estimated_weeks,
    estimated_months,
  };
}

// ─── Main Public API ──────────────────────────────────────────────────────────

/**
 * recommendLearning(userProfile, skillGaps) → LearningRecommendationResult
 *
 * Given a user profile and a list of skill gap names, returns ranked course
 * recommendations for each missing skill.
 *
 * Skill gaps can come from:
 *   - skillDemand engine  (string[] of skill names)
 *   - chiV2 skillGapEngine (array of { skill_id, skill_name, ... } objects)
 *   - Direct API call      (string[] from request body)
 *
 * @param {Object}            userProfile
 * @param {string}            [userProfile.role]
 * @param {string[]}          [userProfile.skills=[]]
 * @param {string}            [userProfile.target_role]
 * @param {string|string[]|Object[]} skillGaps  — skill names or skill objects with skill_name field
 *
 * @returns {Promise<{
 *   learning_recommendations: Array<{ skill, courses: CourseRecord[] }>,
 *   summary: Object,
 *   meta:    Object
 * }>}
 */
async function recommendLearning(userProfile, skillGaps) {
  const profile = userProfile || {};
  const start   = Date.now();

  // ── 1. Normalise skillGaps input ────────────────────────────────────────────
  //   Accept: string[], string (comma-separated), or Object[] with skill_name
  let gapNames = [];

  if (Array.isArray(skillGaps)) {
    gapNames = skillGaps.map(s => {
      if (typeof s === 'string') return s.trim();
      return String(s.skill_name || s.skill || s.skill_id || '').trim();
    }).filter(Boolean);
  } else if (typeof skillGaps === 'string') {
    gapNames = skillGaps.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (gapNames.length === 0) {
    return {
      learning_recommendations: [],
      summary: {
        total_skills_addressed: 0,
        total_courses_found:    0,
        skills_without_courses: [],
        total_hours:            0,
        estimated_weeks:        0,
        estimated_months:       0,
      },
      meta: {
        engine_version:  'learning_v1',
        role:            profile.role  ?? null,
        target_role:     profile.target_role ?? null,
        skill_gaps_in:   0,
        calculated_at:   new Date().toISOString(),
      },
    };
  }

  // ── 2. Load CSV dataset ──────────────────────────────────────────────────────
  const bySkill = await _loadCSV();

  // ── 3. Build recommendations per skill gap ───────────────────────────────────
  const learning_recommendations = [];
  const skills_without_courses   = [];
  let   total_courses_found       = 0;

  for (const skillName of gapNames) {
    const allCourses = _findCourses(bySkill, skillName);
    const courses    = allCourses.slice(0, MAX_COURSES_PER_SKILL);

    if (courses.length === 0) {
      skills_without_courses.push(skillName);
      // Still include entry so caller knows the gap exists even without a course
      learning_recommendations.push({
        skill:   skillName,
        courses: [],
        note:    'No courses found in dataset — consider searching Coursera, Udemy, or LinkedIn Learning',
      });
      continue;
    }

    total_courses_found += courses.length;

    learning_recommendations.push({
      skill:   skillName,
      courses: courses.map(c => ({
        course_name:    c.course_name,
        provider:       c.provider,
        level:          c.level,
        duration_hours: c.duration_hours || null,
        url:            c.url,
      })),
    });
  }

  // ── 4. Learning time estimate ────────────────────────────────────────────────
  const timeEstimate = _estimateLearningTime(learning_recommendations);

  logger.info('[LearningEngine] Recommendations generated', {
    role:            profile.role ?? 'unknown',
    gaps_in:         gapNames.length,
    courses_found:   total_courses_found,
    gaps_unfilled:   skills_without_courses.length,
    elapsed_ms:      Date.now() - start,
  });

  return {
    learning_recommendations,
    summary: {
      total_skills_addressed: learning_recommendations.filter(r => r.courses.length > 0).length,
      total_courses_found,
      skills_without_courses,
      ...timeEstimate,
    },
    meta: {
      engine_version:   'learning_v1',
      role:             profile.role       ?? null,
      target_role:      profile.target_role ?? null,
      skill_gaps_in:    gapNames.length,
      max_courses_per_skill: MAX_COURSES_PER_SKILL,
      calculated_at:    new Date().toISOString(),
    },
  };
}

/**
 * Invalidate the CSV cache.
 * Useful in development after updating learning-resources.csv.
 */
function invalidateCache() {
  _cache.bySkill  = null;
  _cache.loadedAt = null;
  logger.info('[LearningEngine] Cache invalidated');
}

module.exports = {
  recommendLearning,
  invalidateCache,
  // Exported for unit tests
  _findCourses,
  _estimateLearningTime,
  _normaliseLevel,
  LEVEL_ORDER,
};








