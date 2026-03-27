'use strict';

/**
 * modules/skill-prioritization/index.js
 *
 * Wires the SkillPrioritizationEngine with lightweight adapters backed by
 * data sources that are already seeded and working in this codebase:
 *
 *   roleSkillMatrixRepo  — stub (engine falls back to CSV role-skills.csv)
 *   careerGraphRepo      — wraps career.repository (JSON files in /data/career-graph)
 *   skillMarketRepo      — stub (engine falls back to CSV skills-demand-india.csv)
 *   userRepo             — wraps Firestore userProfiles collection
 *
 * The engine itself handles all CSV fallbacks internally, so these adapters
 * only need to surface data that exists beyond CSV (career graph, user profile).
 */

const SkillPrioritizationEngine = require('../../intelligence/skill-prioritization.engine');
const careerRepo = require('../../repositories/career.repository');

// ─── roleSkillMatrixRepo — stub, engine uses CSV fallback ─────────────────────
const roleSkillMatrixRepo = {
  getMatrix: async () => null,
};

// ─── careerGraphRepo — wraps career.repository ────────────────────────────────
// Engine calls: getCareerPath(currentRoleId, targetRoleId)
// Returns: { nextRole, requiredExperienceYears, requiredSkills[] } | null
const careerGraphRepo = {
  getCareerPath: async (currentRoleId, targetRoleId) => {
    try {
      const targetRole = careerRepo.getRole(targetRoleId);
      if (!targetRole) return null;

      return {
        nextRole:                targetRole.title     || targetRoleId,
        requiredExperienceYears: targetRole.min_experience_years || 0,
        // role JSON stores required_skills as string[] or skill_id[]
        requiredSkills: (targetRole.required_skills || []).map(s =>
          typeof s === 'string' ? { skillId: s, name: s } : s
        ),
      };
    } catch (_) {
      return null;
    }
  },
};

// ─── skillMarketRepo — stub, engine uses CSV fallback ────────────────────────
const skillMarketRepo = {
  getMarketData: async () => null,
};

// ─── userRepo — reads from Firestore userProfiles ────────────────────────────
// Engine calls: findById(userId)
// Returns: { isPremium } | null
const userRepo = {
  findById: async (userId) => {
    if (!userId) return null;
    try {
      const { db } = require('../../config/supabase');
      const snap = await db.collection('userProfiles').doc(userId).get();
      if (!snap.exists) return null;
      const data = snap.data();
      return { isPremium: data.isPremium || data.plan === 'premium' || false };
    } catch (_) {
      return null;
    }
  },
};

// ─── Singleton engine instance ────────────────────────────────────────────────
const engine = new SkillPrioritizationEngine({
  roleSkillMatrixRepo,
  careerGraphRepo,
  skillMarketRepo,
  userRepo,
});

module.exports = engine;








