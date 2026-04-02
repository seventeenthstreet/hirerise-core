'use strict';

const skillGraph = require('./SkillGraph');
const logger     = require('../../utils/logger');

// ─── CACHE (LRU-lite) ─────────────────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

function _get(key) {
  try {
    const entry = _cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.ts > CACHE_TTL) {
      _cache.delete(key);
      return null;
    }

    return entry.val;
  } catch (err) {
    logger.warn('[SkillGraphService] Cache read failed', { err: err?.message });
    return null;
  }
}

function _set(key, val) {
  try {
    if (_cache.size >= MAX_CACHE_SIZE) {
      const firstKey = _cache.keys().next().value;
      if (firstKey) _cache.delete(firstKey);
    }

    _cache.set(key, { val, ts: Date.now() });
  } catch (err) {
    logger.warn('[SkillGraphService] Cache write failed', { err: err?.message });
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function _normalizeSkills(skills = []) {
  return skills
    .map(s => (typeof s === 'string' ? s : s?.name || ''))
    .filter(Boolean);
}

// ─── SKILL LOOKUP ─────────────────────────────────────────────────────────────

async function getSkill(skillId) {
  if (!skillId) throw new Error('skillId is required');

  try {
    return skillGraph.getSkill(skillId);
  } catch (err) {
    logger.error('[SkillGraphService] getSkill failed', { skillId, err: err?.message });
    throw err;
  }
}

async function getAllSkills({ category, limit = 200 } = {}) {
  const key = `all:${category || 'all'}:${limit}`;
  const cached = _get(key);
  if (cached) return cached;

  try {
    let result;

    if (category) {
      const skills = skillGraph.getSkillsByCategory(category) || [];
      result = skills.slice(0, limit);
    } else {
      const skills = skillGraph.allSkills() || [];
      result = skills.slice(0, limit);
    }

    _set(key, result);
    return result;
  } catch (err) {
    logger.error('[SkillGraphService] getAllSkills failed', { err: err?.message });
    return [];
  }
}

async function searchSkills(query, opts = {}) {
  if (!query || String(query).trim().length < 2) return [];

  try {
    return skillGraph.searchSkills(query, opts) || [];
  } catch (err) {
    logger.error('[SkillGraphService] searchSkills failed', { query, err: err?.message });
    return [];
  }
}

// ─── RELATIONSHIPS ────────────────────────────────────────────────────────────

async function getRelationships(skillId, type = null) {
  if (!skillId) throw new Error('skillId is required');

  try {
    return skillGraph.getRelationships(skillId, type) || [];
  } catch (err) {
    logger.error('[SkillGraphService] getRelationships failed', { skillId, err: err?.message });
    return [];
  }
}

async function getPrerequisites(skillId, deep = true) {
  if (!skillId) throw new Error('skillId is required');

  const key = `prereq:${skillId}:${deep}`;
  const cached = _get(key);
  if (cached) return cached;

  try {
    const result = skillGraph.getPrerequisites(skillId, deep) || [];
    _set(key, result);
    return result;
  } catch (err) {
    logger.error('[SkillGraphService] getPrerequisites failed', { skillId, err: err?.message });
    return [];
  }
}

async function getAdvancedSkills(skillId) {
  if (!skillId) throw new Error('skillId is required');

  try {
    return skillGraph.getAdvancedSkills(skillId) || [];
  } catch (err) {
    logger.error('[SkillGraphService] getAdvancedSkills failed', { skillId, err: err?.message });
    return [];
  }
}

async function getRelatedSkills(skillId) {
  if (!skillId) throw new Error('skillId is required');

  try {
    return skillGraph.getRelatedSkills(skillId) || [];
  } catch (err) {
    logger.error('[SkillGraphService] getRelatedSkills failed', { skillId, err: err?.message });
    return [];
  }
}

// ─── ROLE SKILL MAP ───────────────────────────────────────────────────────────

async function getRoleSkillMap(roleId) {
  if (!roleId) throw new Error('roleId is required');

  const key = `role:${roleId}`;
  const cached = _get(key);
  if (cached) return cached;

  try {
    const result = skillGraph.getRoleSkillMap(roleId) || { required: [], preferred: [] };
    _set(key, result);
    return result;
  } catch (err) {
    logger.error('[SkillGraphService] getRoleSkillMap failed', { roleId, err: err?.message });
    return { required: [], preferred: [] };
  }
}

// ─── GAP DETECTION (FIXED + SAFE) ─────────────────────────────────────────────

async function detectGap(userSkills, roleId) {
  if (!roleId) throw new Error('roleId is required');
  if (!Array.isArray(userSkills)) throw new Error('userSkills must be an array');

  const normalizedSkills = _normalizeSkills(userSkills);

  let result;

  try {
    result = skillGraph.detectGap(normalizedSkills, roleId);
  } catch (err) {
    logger.error('[SkillGraphService] detectGap failed', { roleId, err: err?.message });
    throw err;
  }

  if (!result) {
    logger.warn('[SkillGraphService] detectGap returned null', { roleId });
    return {
      role_id: roleId,
      matched_skills: [],
      missing_required: [],
      missing_preferred: [],
      required_match_pct: 0,
      coverage_label: 'low'
    };
  }

  logger.debug('[SkillGraphService] detectGap', {
    roleId,
    userCount: normalizedSkills.length,
    matchPct: result.required_match_pct,
    missingCnt: result.missing_required?.length || 0
  });

  return result;
}

// ─── LEARNING PATHS ───────────────────────────────────────────────────────────

async function generateLearningPath(targetSkillId, userSkills = []) {
  if (!targetSkillId) throw new Error('targetSkillId is required');

  try {
    return skillGraph.generateLearningPath(targetSkillId, userSkills) || {};
  } catch (err) {
    logger.error('[SkillGraphService] generateLearningPath failed', {
      targetSkillId,
      err: err?.message
    });
    return {};
  }
}

async function generateLearningPaths(userSkills, roleId) {
  if (!roleId) throw new Error('roleId is required');

  try {
    const gap = await detectGap(userSkills, roleId);

    if (!gap.priority_missing?.length) {
      return {
        paths: [],
        total_skills_to_learn: 0,
        estimated_weeks: 0,
        estimated_months: 0
      };
    }

    return skillGraph.generateLearningPaths(gap.priority_missing, userSkills) || {};
  } catch (err) {
    logger.error('[SkillGraphService] generateLearningPaths failed', {
      roleId,
      err: err?.message
    });
    return {};
  }
}

// ─── SKILL SCORE ──────────────────────────────────────────────────────────────

async function computeSkillScore(userSkills, roleId, weight = 0.30) {
  if (!roleId) throw new Error('roleId is required');

  try {
    return skillGraph.computeSkillScore(userSkills, roleId, weight) || {};
  } catch (err) {
    logger.error('[SkillGraphService] computeSkillScore failed', {
      roleId,
      err: err?.message
    });
    return {};
  }
}

// ─── INTELLIGENCE REPORT ──────────────────────────────────────────────────────

async function getSkillIntelligence(userSkills, roleId, opts = {}) {
  const { weight = 0.30 } = opts;

  try {
    const [gap, learningPaths, skillScore] = await Promise.all([
      detectGap(userSkills, roleId),
      generateLearningPaths(userSkills, roleId),
      computeSkillScore(userSkills, roleId, weight),
    ]);

    return {
      role_id: roleId,
      gap_analysis: gap,
      learning_paths: learningPaths,
      skill_score: skillScore,
      summary: {
        match_pct: gap.required_match_pct || 0,
        coverage_label: gap.coverage_label || 'low',
        missing_count: gap.missing_required?.length || 0,
        top_missing: (gap.priority_missing || []).slice(0, 3)
          .map(e => e.skill?.skill_name || e.skill_id),
        estimated_months: learningPaths.estimated_months || 0,
        chi_contribution: skillScore.weighted_contribution || 0,
      },
    };
  } catch (err) {
    logger.error('[SkillGraphService] getSkillIntelligence failed', {
      roleId,
      err: err?.message
    });

    return null;
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  getSkill,
  getAllSkills,
  searchSkills,
  getRelationships,
  getPrerequisites,
  getAdvancedSkills,
  getRelatedSkills,
  getRoleSkillMap,
  detectGap,
  generateLearningPath,
  generateLearningPaths,
  computeSkillScore,
  getSkillIntelligence,
};
