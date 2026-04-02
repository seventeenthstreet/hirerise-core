'use strict';

/**
 * modules/skill-prioritization/index.js
 *
 * Supabase-fixed version — no Firestore left
 */

const SkillPrioritizationEngine = require('../../intelligence/skill-prioritization.engine');
const careerRepo = require('../../repositories/career.repository');
const { supabase } = require('../../config/supabase');

// ─── roleSkillMatrixRepo — stub ──────────────────────────────────────────────
const roleSkillMatrixRepo = {
  getMatrix: async () => null
};

// ─── careerGraphRepo — unchanged ─────────────────────────────────────────────
const careerGraphRepo = {
  getCareerPath: async (currentRoleId, targetRoleId) => {
    try {
      const targetRole = careerRepo.getRole(targetRoleId);
      if (!targetRole) return null;

      return {
        nextRole: targetRole.title || targetRoleId,
        requiredExperienceYears: targetRole.min_experience_years || 0,
        requiredSkills: (targetRole.required_skills || []).map(s =>
          typeof s === 'string'
            ? { skillId: s, name: s }
            : s
        )
      };

    } catch (_) {
      return null;
    }
  }
};

// ─── skillMarketRepo — stub ──────────────────────────────────────────────────
const skillMarketRepo = {
  getMarketData: async () => null
};

// ─── userRepo — FIXED (Supabase) ─────────────────────────────────────────────
const userRepo = {
  findById: async userId => {

    if (!userId) return null;

    try {
      const { data, error } = await supabase
        .from('userProfiles')
        .select('isPremium, plan') // optimized select
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;

      if (!data) return null;

      return {
        isPremium:
          data.isPremium ||
          data.plan === 'premium' ||
          false
      };

    } catch (_) {
      return null;
    }
  }
};

// ─── Engine instance ─────────────────────────────────────────────────────────
const engine = new SkillPrioritizationEngine({
  roleSkillMatrixRepo,
  careerGraphRepo,
  skillMarketRepo,
  userRepo
});

module.exports = engine;
