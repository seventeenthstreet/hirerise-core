'use strict';

/**
 * modules/skill-prioritization/index.js
 *
 * Production-ready Supabase-native dependency wiring for the
 * SkillPrioritizationEngine.
 *
 * Improvements:
 * - Removed remaining Firebase/Firestore-era repository assumptions
 * - Fixed async repository usage consistency
 * - Added null-safe row handling
 * - Improved Supabase query efficiency
 * - Added stable logging behavior
 * - Hardened error isolation for non-critical repos
 * - Singleton-safe engine dependency graph
 */

const SkillPrioritizationEngine = require('../../intelligence/skill-prioritization.engine');
const careerRepo = require('../../repositories/career.repository');
const { supabase } = require('../../config/supabase');

/**
 * Minimal structured logger for module-level dependency failures.
 * Keeps logging consistent with production observability standards
 * without introducing hard dependency coupling.
 */
const logRepoError = (repo, operation, error, meta = {}) => {
  console.error(`[skill-prioritization] ${repo}.${operation} failed`, {
    message: error?.message,
    code: error?.code,
    details: error?.details,
    ...meta
  });
};

/**
 * roleSkillMatrixRepo
 *
 * Reserved for future SQL-backed matrix retrieval.
 * Kept as a null-object adapter so business logic remains unchanged.
 */
const roleSkillMatrixRepo = Object.freeze({
  async getMatrix() {
    return null;
  }
});

/**
 * careerGraphRepo
 *
 * Converts role repository output into engine-compatible graph shape.
 * Fully async-safe and resilient to repository failures.
 */
const careerGraphRepo = Object.freeze({
  async getCareerPath(currentRoleId, targetRoleId) {
    if (!targetRoleId) return null;

    try {
      const targetRole = await careerRepo.getRole(targetRoleId);
      if (!targetRole) return null;

      const requiredSkills = Array.isArray(targetRole.required_skills)
        ? targetRole.required_skills.map(skill =>
            typeof skill === 'string'
              ? { skillId: skill, name: skill }
              : {
                  skillId: skill.skillId || skill.id || skill.name,
                  name: skill.name || skill.skillId || skill.id
                }
          )
        : [];

      return {
        nextRole: targetRole.title || targetRoleId,
        requiredExperienceYears:
          Number(targetRole.min_experience_years) || 0,
        requiredSkills
      };
    } catch (error) {
      logRepoError('careerGraphRepo', 'getCareerPath', error, {
        currentRoleId,
        targetRoleId
      });
      return null;
    }
  }
});

/**
 * skillMarketRepo
 *
 * Null-object adapter maintained intentionally.
 * Replace with SQL analytics or materialized view later if needed.
 */
const skillMarketRepo = Object.freeze({
  async getMarketData() {
    return null;
  }
});

/**
 * userRepo
 *
 * Supabase-native row-based repository adapter.
 * Optimized for:
 * - minimal column fetch
 * - nullable row safety
 * - stable boolean normalization
 * - connection reuse via shared singleton client
 */
const userRepo = Object.freeze({
  async findById(userId) {
    if (!userId) return null;

    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('is_premium, plan')
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        logRepoError('userRepo', 'findById', error, { userId });
        return null;
      }

      if (!data) return null;

      const plan = typeof data.plan === 'string'
        ? data.plan.toLowerCase()
        : null;

      return {
        isPremium: Boolean(
          data.is_premium ||
          plan === 'premium' ||
          plan === 'pro' ||
          plan === 'enterprise'
        )
      };
    } catch (error) {
      logRepoError('userRepo', 'findById', error, { userId });
      return null;
    }
  }
});

/**
 * Singleton engine instance
 *
 * Safe for module caching + connection reuse.
 */
const engine = new SkillPrioritizationEngine({
  roleSkillMatrixRepo,
  careerGraphRepo,
  skillMarketRepo,
  userRepo
});

module.exports = engine;