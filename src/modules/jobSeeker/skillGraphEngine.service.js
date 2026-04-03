'use strict';

/**
 * src/modules/jobSeeker/skillGraphEngine.service.js
 *
 * Fully Supabase-native skill graph engine
 * - Firebase snapshot patterns removed
 * - Supabase table names normalized
 * - Cache standardized
 * - Null safe
 * - Business logic preserved
 */

const { supabase } = require('../../config/supabase');
const svc = require('../skillGraph/skillGraph.service');
const cacheManager = require('../../core/cache/cache.manager');
const logger = require('../../utils/logger');

const CACHE_TTL_SECONDS = 600;
const cache = cacheManager.getClient();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function normalizeSkills(rawSkills) {
  if (!Array.isArray(rawSkills)) return [];

  return rawSkills
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean);
}

async function loadUserProfile(userId) {
  const [profileRes, progressRes, userRes] = await Promise.all([
    supabase
      .from('user_profiles')
      .select(`
        id,
        skills,
        target_role,
        current_job_title,
        industry,
        experience_years
      `)
      .eq('id', userId)
      .maybeSingle(),

    supabase
      .from('onboarding_progress')
      .select(`
        id,
        skills,
        target_role,
        industry,
        experience_years
      `)
      .eq('id', userId)
      .maybeSingle(),

    supabase
      .from('users')
      .select(`
        id,
        skills,
        current_job_title,
        industry,
        experience_years
      `)
      .eq('id', userId)
      .maybeSingle()
  ]);

  if (profileRes.error) throw profileRes.error;
  if (progressRes.error) throw progressRes.error;
  if (userRes.error) throw userRes.error;

  const profile = profileRes.data || {};
  const progress = progressRes.data || {};
  const user = userRes.data || {};

  const rawSkills =
    profile.skills ||
    user.skills ||
    progress.skills ||
    [];

  return {
    skills: normalizeSkills(rawSkills),
    targetRole:
      profile.target_role ||
      profile.current_job_title ||
      user.current_job_title ||
      progress.target_role ||
      null,
    industry:
      profile.industry ||
      user.industry ||
      progress.industry ||
      null,
    yearsExperience:
      profile.experience_years ??
      user.experience_years ??
      progress.experience_years ??
      0
  };
}

async function cached(key, ttl, fn) {
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

// ─────────────────────────────────────────────────────────────
// USER SKILL GRAPH
// ─────────────────────────────────────────────────────────────

async function getUserSkillGraph(userId) {
  const cacheKey = `skill-graph:user:${userId}`;

  return cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const { skills, targetRole, industry } =
      await loadUserProfile(userId);

    if (!skills.length) {
      return {
        existing_skills: [],
        adjacent_skills: [],
        next_level_skills: [],
        role_specific_skills: [],
        skill_count: 0,
        message:
          'No skills found in profile. Complete onboarding to see your skill graph.'
      };
    }

    const userSkillSet = new Set(
      skills.map((s) => s.toLowerCase())
    );

    const adjacentSet = new Map();
    const nextLevelSet = new Map();
    const BATCH = 5;

    for (let i = 0; i < skills.length; i += BATCH) {
      const batch = skills.slice(i, i + BATCH);

      const results = await Promise.allSettled(
        batch.map((skill) =>
          Promise.all([
            svc.getAdvancedSkills(skill).catch(() => []),
            svc.getRelatedSkills(skill).catch(() => [])
          ])
        )
      );

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;

        const [advanced, related] = result.value;

        for (const skill of advanced) {
          const name =
            skill.name || skill.skill_name || skill.id;

          if (
            name &&
            !userSkillSet.has(name.toLowerCase())
          ) {
            nextLevelSet.set(name, skill);
          }
        }

        for (const skill of related) {
          const name =
            skill.name || skill.skill_name || skill.id;

          if (
            name &&
            !userSkillSet.has(name.toLowerCase())
          ) {
            adjacentSet.set(name, skill);
          }
        }
      }
    }

    let roleSpecific = [];

    if (targetRole) {
      try {
        const roleMap = await svc.getRoleSkillMap(targetRole);

        if (roleMap) {
          const required = [
            ...(roleMap.required || []),
            ...(roleMap.preferred || [])
          ];

          roleSpecific = required
            .filter((skill) => {
              const name = (
                skill.name ||
                skill.skill_name ||
                ''
              ).toLowerCase();

              return name && !userSkillSet.has(name);
            })
            .slice(0, 10);
        }
      } catch (_) {}
    }

    logger.info('[SkillGraphEngine] getUserSkillGraph', {
      userId,
      skillCount: skills.length,
      adjacentCount: adjacentSet.size,
      nextCount: nextLevelSet.size
    });

    return {
      existing_skills: skills,
      adjacent_skills: [...adjacentSet.keys()].slice(0, 15),
      next_level_skills: [...nextLevelSet.keys()].slice(0, 10),
      role_specific_skills: roleSpecific.map(
        (s) => s.name || s.skill_name || s.id
      ),
      target_role: targetRole,
      industry,
      skill_count: skills.length
    };
  });
}

// ─────────────────────────────────────────────────────────────
// SKILL GAP
// ─────────────────────────────────────────────────────────────

async function detectSkillGap(userId) {
  const cacheKey = `skill-gap:user:${userId}`;

  return cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const {
      skills,
      targetRole,
      industry,
      yearsExperience
    } = await loadUserProfile(userId);

    if (!skills.length) {
      return {
        existing_skills: [],
        adjacent_skills: [],
        missing_high_demand: [],
        learning_paths: [],
        gap_summary:
          'Upload your CV to see your personalised skill gap analysis.'
      };
    }

    let gapResult = null;

    if (targetRole) {
      try {
        gapResult = await svc.detectGap(skills, targetRole);
      } catch (_) {}
    }

    let missingHighDemand = [];

    if (
      gapResult &&
      (
        gapResult.missing_required?.length ||
        gapResult.missing_preferred?.length
      )
    ) {
      const required = (gapResult.missing_required || []).map((e) => ({
        name:
          e.skill?.skill_name ||
          e.skill_id?.replace(/_/g, ' ') ||
          e.skill_id,
        skill_id: e.skill_id,
        demand_score: e.skill?.demand_score || 70,
        category: e.skill?.skill_category || 'domain',
        difficulty: e.skill?.difficulty_level || null,
        gap_type: 'required'
      }));

      const preferred = (gapResult.missing_preferred || [])
        .slice(0, 5)
        .map((e) => ({
          name:
            e.skill?.skill_name ||
            e.skill_id?.replace(/_/g, ' ') ||
            e.skill_id,
          skill_id: e.skill_id,
          demand_score: e.skill?.demand_score || 55,
          category: e.skill?.skill_category || 'domain',
          difficulty: e.skill?.difficulty_level || null,
          gap_type: 'preferred'
        }));

      missingHighDemand = [...required, ...preferred].slice(0, 10);
    } else {
      const graphResult = await getUserSkillGraph(userId);
      missingHighDemand = (graphResult.adjacent_skills || [])
        .slice(0, 10)
        .map((name) => ({
          name,
          skill_id: name.toLowerCase().replace(/\s+/g, '_'),
          demand_score: 60,
          category: 'adjacent',
          gap_type: 'adjacent'
        }));
    }

    const learningPaths = [];

    for (const missing of missingHighDemand.slice(0, 3)) {
      try {
        const skillKey =
          missing.skill_id ||
          missing.name.toLowerCase().replace(/\s+/g, '_');

        const path = await svc.generateLearningPath(
          skillKey,
          skills
        );

        if (path) {
          learningPaths.push({
            skill: missing.name,
            path
          });
        }
      } catch (_) {}
    }

    const graphResult = await getUserSkillGraph(userId);

    return {
      existing_skills: skills,
      adjacent_skills: graphResult.adjacent_skills || [],
      missing_high_demand: missingHighDemand,
      role_gap: gapResult
        ? {
            target_role: targetRole,
            match_percentage:
              gapResult.required_match_pct || 0
          }
        : null,
      learning_paths: learningPaths,
      years_experience: yearsExperience,
      target_role: targetRole,
      industry
    };
  });
}

module.exports = {
  getUserSkillGraph,
  detectSkillGap
};

if (process.env.FEATURE_SEMANTIC_MATCHING === 'true') {
  try {
    require('./skillGraphEngine.semantic.patch').apply(
      module.exports
    );

    logger.info('[SkillGraphEngine] semantic patch applied');
  } catch (error) {
    logger.warn(
      '[SkillGraphEngine] semantic patch load failed',
      {
        error: error.message
      }
    );
  }
}