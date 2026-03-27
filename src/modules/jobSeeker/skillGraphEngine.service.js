'use strict';

/**
 * skillGraphEngine.service.js — Skill Graph Engine (Job Seeker Path)
 *
 * Connects the logged-in user's CV-extracted skills to the existing
 * SkillGraph engine to produce personalised:
 *   - Adjacent / next-level skill suggestions
 *   - Skill gap vs market demand
 *   - Learning path recommendations
 *
 * Data sources (read-only):
 *   Firestore userProfiles/{uid}  — skills[], targetRole, industry
 *   SkillGraph (in-process)       — graph traversal, gap detection
 *   CacheManager                  — Redis (prod) / Memory (dev) — TTL 10 min
 *
 * @module modules/jobSeeker/skillGraphEngine.service
 */
const {
  db
} = require('../../config/supabase');
const svc = require('../skillGraph/skillGraph.service');
const cacheManager = require('../../core/cache/cache.manager');
const logger = require('../../utils/logger');
const CACHE_TTL_SECONDS = 600; // 10 minutes
const cache = cacheManager.getClient();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load user profile from Firestore.
 * Returns { skills, targetRole, industry, yearsExperience } or throws.
 */
async function _loadUserProfile(userId) {
  // Read from all three collections — whichever was populated by resume.service.js wins.
  // userProfiles: written by new resume.service.js (post-fix)
  // users: written by old resume.service.js (existing users before fix)
  // onboardingProgress: fallback for users who completed onboarding manually
  const [profileSnap, progressSnap, userSnap] = await Promise.all([supabase.from('userProfiles').select("*").eq("id", userId).single(), supabase.from('onboardingProgress').select("*").eq("id", userId).single(), supabase.from('users').select("*").eq("id", userId).single()]);
  const profile = profileSnap.exists ? profileSnap.data() : {};
  const progress = progressSnap.exists ? progressSnap.data() : {};
  const user = userSnap.exists ? userSnap.data() : {};

  // Pick first non-empty skills array: userProfiles → users → onboardingProgress
  const rawSkills = Array.isArray(profile.skills) && profile.skills.length > 0 ? profile.skills : Array.isArray(user.skills) && user.skills.length > 0 ? user.skills : Array.isArray(progress.skills) && progress.skills.length > 0 ? progress.skills : [];

  // Normalise to string[]
  const skills = rawSkills.map(s => typeof s === 'string' ? s : s?.name).filter(Boolean);
  return {
    skills,
    targetRole: profile.targetRole || profile.currentJobTitle || user.currentJobTitle || progress.targetRole || null,
    industry: profile.industry || user.industry || progress.industry || null,
    yearsExperience: profile.experienceYears || profile.yearsExperience || user.experience || user.experienceYears || progress.experienceYears || 0
  };
}

/**
 * Cache wrapper — get then set.
 */
async function _cached(key, ttl, fn) {
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (_) {/* cache miss is fine */}
  const result = await fn();
  try {
    // MemoryCache.set(key, value, ttlSeconds) — no Redis-style 'EX' flag
    await cache.set(key, JSON.stringify(result), ttl);
  } catch (_) {/* non-fatal */}
  return result;
}

// ─── getUserSkillGraph ────────────────────────────────────────────────────────

/**
 * Build a personalised skill graph for a user.
 *
 * For each skill the user has:
 *   - Look up adjacent skills (advanced + related)
 *   - Filter out skills the user already owns
 *
 * @param {string} userId
 * @returns {Promise<SkillGraphResult>}
 */
async function getUserSkillGraph(userId) {
  const cacheKey = `skill-graph:user:${userId}`;
  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const {
      skills,
      targetRole,
      industry
    } = await _loadUserProfile(userId);
    if (skills.length === 0) {
      return {
        existing_skills: [],
        adjacent_skills: [],
        next_level_skills: [],
        role_specific_skills: [],
        skill_count: 0,
        message: 'No skills found in profile. Complete onboarding to see your skill graph.'
      };
    }
    const userSkillSet = new Set(skills.map(s => s.toLowerCase()));

    // For each user skill, fetch advanced and related skills in parallel (batch of 5)
    const adjacentSet = new Map(); // name → SkillNode
    const nextLevelSet = new Map();
    const BATCH = 5;
    for (let i = 0; i < skills.length; i += BATCH) {
      const batch = skills.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(skill => Promise.all([svc.getAdvancedSkills(skill).catch(() => []), svc.getRelatedSkills(skill).catch(() => [])])));
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const [advanced, related] = r.value;
        for (const s of advanced) {
          if (!userSkillSet.has((s.name || s.skill_name || '').toLowerCase())) {
            const name = s.name || s.skill_name || s.id;
            nextLevelSet.set(name, s);
          }
        }
        for (const s of related) {
          if (!userSkillSet.has((s.name || s.skill_name || '').toLowerCase())) {
            const name = s.name || s.skill_name || s.id;
            adjacentSet.set(name, s);
          }
        }
      }
    }

    // Role-specific skills — fetch if we know the target role
    let roleSpecific = [];
    if (targetRole) {
      try {
        const roleMap = await svc.getRoleSkillMap(targetRole).catch(() => null);
        if (roleMap) {
          const required = [...(roleMap.required || []), ...(roleMap.preferred || [])];
          roleSpecific = required.filter(s => {
            const name = (s.name || s.skill_name || '').toLowerCase();
            return name && !userSkillSet.has(name);
          }).slice(0, 10);
        }
      } catch (_) {/* non-fatal */}
    }
    logger.info('[SkillGraphEngine] getUserSkillGraph', {
      userId,
      skillCount: skills.length,
      adjacentCount: adjacentSet.size,
      nextCount: nextLevelSet.size
    });
    return {
      existing_skills: skills,
      adjacent_skills: [...adjacentSet.values()].slice(0, 15).map(s => s.name || s.skill_name || s.id),
      next_level_skills: [...nextLevelSet.values()].slice(0, 10).map(s => s.name || s.skill_name || s.id),
      role_specific_skills: roleSpecific.map(s => s.name || s.skill_name || s.id),
      target_role: targetRole,
      industry,
      skill_count: skills.length
    };
  });
}

// ─── detectSkillGap ───────────────────────────────────────────────────────────

/**
 * Detect skill gaps for the user against their target role and market demand.
 *
 * @param {string} userId
 * @returns {Promise<SkillGapResult>}
 */
async function detectSkillGap(userId) {
  const cacheKey = `skill-gap:user:${userId}`;
  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const {
      skills,
      targetRole,
      industry,
      yearsExperience
    } = await _loadUserProfile(userId);
    if (skills.length === 0) {
      return {
        existing_skills: [],
        adjacent_skills: [],
        missing_high_demand: [],
        learning_paths: [],
        gap_summary: 'Upload your CV to see your personalised skill gap analysis.'
      };
    }

    // ── CV-driven skill gap — the only correct approach ─────────────────────
    //
    // FIX: The previous approach scanned ALL skills globally ranked by demand_score
    // and showed Python/Docker/AWS to everyone — including accountants, HR managers,
    // and lawyers. This was wrong because:
    //   1. It ignored what the user's CV actually contains
    //   2. It ignored what their target role actually requires
    //   3. It used global popularity (demand_score) as a proxy for relevance
    //
    // The CORRECT approach is entirely CV-driven:
    //   Step 1 — Read the user's actual skills from their uploaded CV
    //             (already in userProfiles, written by resume.service.js)
    //   Step 2 — Read their target role (detectedRoles[0] from the CV parser,
    //             stored as userProfiles.targetRole by resume.service.js)
    //   Step 3 — Run detectGap(cvSkills, targetRole) → returns exactly which
    //             required skills for that role the user does NOT have
    //   Step 4 — Those missing_required skills become missing_high_demand
    //             They are 100% specific to this user's CV and role
    //   Step 5 — If the role has preferred skills not in the CV, surface those too
    //   Fallback — If no role was detected from CV, use adjacent graph skills
    //              (skills related to what the user already has)

    const userSkillSet = new Set(skills.map(s => s.toLowerCase()));

    // Step 1-3: Role-specific gap from CV target role
    let gapResult = null;
    if (targetRole) {
      try {
        gapResult = await svc.detectGap(skills, targetRole);
      } catch (_) {/* fall through to adjacency fallback */}
    }

    // Step 4: Build missing_high_demand from role gap (CV-driven, role-specific)
    let missingHighDemand = [];
    if (gapResult && (gapResult.missing_required.length > 0 || gapResult.missing_preferred.length > 0)) {
      // Primary: skills the target role REQUIRES that the user doesn't have
      const missingRequired = (gapResult.missing_required || []).map(e => ({
        name: e.skill?.skill_name || e.skill_id?.replace(/_/g, ' ') || e.skill_id,
        skill_id: e.skill_id,
        demand_score: e.skill?.demand_score || 70,
        // normalise to 0-100 scale for frontend
        category: e.skill?.skill_category || 'domain',
        difficulty: e.skill?.difficulty_level || null,
        gap_type: 'required' // tells frontend this is role-required
      })).filter(s => s.name);

      // Secondary: preferred/nice-to-have skills for the role
      const missingPreferred = (gapResult.missing_preferred || []).slice(0, 5).map(e => ({
        name: e.skill?.skill_name || e.skill_id?.replace(/_/g, ' ') || e.skill_id,
        skill_id: e.skill_id,
        demand_score: e.skill?.demand_score || 55,
        category: e.skill?.skill_category || 'domain',
        difficulty: e.skill?.difficulty_level || null,
        gap_type: 'preferred'
      })).filter(s => s.name);
      missingHighDemand = [...missingRequired, ...missingPreferred].slice(0, 10);
    } else {
      // Fallback: no role detected from CV, or role has no required skills defined.
      // Use graph adjacency — skills related to what the user already HAS.
      // This is still CV-driven (based on user's existing skills) just not role-specific.
      const graphResult = await getUserSkillGraph(userId).catch(() => null);
      const adjacentSkills = graphResult?.adjacent_skills || [];
      missingHighDemand = adjacentSkills.slice(0, 10).map(name => ({
        name,
        skill_id: name.toLowerCase().replace(/\s+/g, '_'),
        demand_score: 60,
        category: 'adjacent',
        gap_type: 'adjacent'
      }));
    }

    // Generate learning paths for top 3 missing CV-driven skills
    const learningPaths = [];
    for (const missing of missingHighDemand.slice(0, 3)) {
      try {
        const skillKey = missing.skill_id || missing.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const path = await svc.generateLearningPath(skillKey, skills);
        if (path) learningPaths.push({
          skill: missing.name,
          path
        });
      } catch (_) {/* non-fatal */}
    }

    // Adjacent skills (for skill graph visualisation, separate from gap recommendations)
    const graphResult = await getUserSkillGraph(userId).catch(() => null);
    logger.info('[SkillGraphEngine] detectSkillGap', {
      userId,
      skillCount: skills.length,
      targetRole,
      missingCount: missingHighDemand.length,
      hasGapResult: !!gapResult,
      matchPct: gapResult?.required_match_pct ?? null
    });
    return {
      existing_skills: skills,
      adjacent_skills: graphResult?.adjacent_skills || [],
      // CV-driven: only skills missing from THIS user's role, from THIS user's CV
      missing_high_demand: missingHighDemand,
      role_gap: gapResult ? {
        target_role: targetRole,
        match_percentage: gapResult.required_match_pct || 0,
        missing_required: (gapResult.missing_required || []).slice(0, 8).map(e => e.skill?.skill_name || e.skill_id?.replace(/_/g, ' ') || e.skill_id).filter(Boolean),
        priority_missing: (gapResult.priority_missing || []).slice(0, 5).map(e => ({
          name: e.skill?.skill_name || e.skill_id?.replace(/_/g, ' ') || e.skill_id,
          priority: e.importance_weight >= 1.0 ? 'high' : 'medium'
        })).filter(e => e.name)
      } : null,
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

// ─── Semantic AI Upgrade 1 — Patch ───────────────────────────────────────────
//
// Activates SemanticSkillEngine as a fallback when a skill has fewer than
// MIN_ADJACENT_SKILLS graph neighbours.
//
// The patch wraps getUserSkillGraph() — it is ADDITIVE and never removes
// existing graph data. Controlled by FEATURE_SEMANTIC_MATCHING env flag.
//
// File: src/modules/jobSeeker/skillGraphEngine.semantic.patch.js
//
if (process.env.FEATURE_SEMANTIC_MATCHING === 'true') {
  try {
    require('./skillGraphEngine.semantic.patch').apply(module.exports);
    logger.info('[SkillGraphEngine] semantic patch applied');
  } catch (err) {
    logger.warn('[SkillGraphEngine] semantic patch load failed — continuing without it', {
      err: err.message
    });
  }
}