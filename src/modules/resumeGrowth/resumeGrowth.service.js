'use strict';

/**
 * src/modules/resumeGrowth/resumeGrowth.service.js
 *
 * Production-ready orchestration layer
 * -----------------------------------
 * Optimized for:
 * - Supabase repositories
 * - zero Firebase assumptions
 * - non-blocking async flow
 * - skill alias caching
 * - safer persistence
 * - domain-safe errors
 */

const fs = require('fs/promises');
const path = require('path');

const {
  attachDurations,
  calculateSkillCoverage,
  findSkillGaps,
  calculateExperienceDepth,
  calculateEducationAlignment,
  estimateLevel,
  estimateLevelIfImproved,
  assessPromotionReadiness,
} = require('./resumeGrowth.engine');

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

class ResumeGrowthService {
  constructor({ roleRepository, skillRepository, resumeGrowthRepository }) {
    this._roleRepo = roleRepository;
    this._skillRepo = skillRepository;
    this._growthRepo = resumeGrowthRepository;

    /**
     * In-memory alias cache
     * Safe because skills taxonomy changes rarely.
     */
    this._skillAliasMap = null;
  }

  /**
   * Main growth analysis orchestration.
   */
  async analyze({
    userId,
    user_id,
    roleId,
    resume,
    persist = true,
  }) {
    const effectiveUserId = userId || user_id || null;

    const roleContext =
      (await this._roleRepo.findById(roleId)) ||
      (await this._loadRoleFromCareerGraph(roleId));

    if (!roleContext) {
      throw new AppError(
        `Role not found: ${roleId}`,
        404,
        { roleId },
        ErrorCodes.NOT_FOUND
      );
    }

    const safeResume = resume || {};

    const [normalizedSkills, experience] = await Promise.all([
      this._normalizeSkills(safeResume.skills),
      Promise.resolve(attachDurations(safeResume.experience)),
    ]);

    const totalYears = this._computeTotalYears(
      experience,
      safeResume.total_experience_years
    );

    const requiredSkills = Array.isArray(roleContext.required_skills)
      ? roleContext.required_skills
      : [];

    const preferredSkills = Array.isArray(roleContext.preferred_skills)
      ? roleContext.preferred_skills
      : [];

    const skillCoverage = calculateSkillCoverage(
      normalizedSkills,
      requiredSkills,
      preferredSkills
    );

    const skillGapAreas = findSkillGaps(
      normalizedSkills,
      requiredSkills
    );

    const experienceDepthScore = calculateExperienceDepth(
      experience,
      totalYears,
      roleContext
    );

    const educationAlignment = calculateEducationAlignment(
      safeResume.education,
      safeResume.certifications
    );

    const currentLevelEstimate = estimateLevel(
      totalYears,
      skillCoverage
    );

    const estimatedLevelIfImproved = estimateLevelIfImproved(
      totalYears,
      skillCoverage
    );

    const promotionReadiness = assessPromotionReadiness(
      skillCoverage,
      experienceDepthScore,
      educationAlignment
    );

    const signal = {
      roleId,
      currentLevelEstimate,
      skillCoverage,
      experienceDepthScore,
      educationAlignment,
      growthSignals: {
        promotionReadiness,
        skillGapAreas,
        estimatedLevelIfImproved,
      },
    };

    /**
     * Append-only persistence
     */
    if (persist && effectiveUserId) {
      await this._growthRepo.save(
        effectiveUserId,
        roleId,
        signal
      );
    }

    return signal;
  }

  /**
   * Hot latest snapshot lookup.
   * Fully DB-index optimized.
   */
  async getLatest(userId, roleId) {
    return this._growthRepo.getLatest(userId, roleId);
  }

  /**
   * Skill normalization with alias caching.
   * Prevents rebuilding full alias map on every request.
   */
  async _normalizeSkills(rawSkills = []) {
    if (!this._skillAliasMap) {
      const allSkills = await this._skillRepo.getAllWithAliases();
      const aliasMap = new Map();

      for (const skill of allSkills || []) {
        const canonical = String(skill?.name || '')
          .trim()
          .toLowerCase();

        if (!canonical) continue;

        aliasMap.set(canonical, canonical);

        for (const alias of skill.aliases || []) {
          const normalizedAlias = String(alias)
            .trim()
            .toLowerCase();

          if (normalizedAlias) {
            aliasMap.set(normalizedAlias, canonical);
          }
        }
      }

      this._skillAliasMap = aliasMap;
    }

    const normalized = new Set();

    for (const raw of rawSkills || []) {
      const key = String(
        typeof raw === 'string' ? raw : raw?.name || ''
      )
        .trim()
        .toLowerCase();

      if (key) {
        normalized.add(this._skillAliasMap.get(key) || key);
      }
    }

    return [...normalized];
  }

  _computeTotalYears(experience = [], providedYears) {
    if (Number.isFinite(providedYears)) {
      return providedYears;
    }

    const totalMonths = experience.reduce(
      (sum, item) => sum + (item?.duration_months || 0),
      0
    );

    return Math.round((totalMonths / 12) * 10) / 10;
  }

  /**
   * Async JSON fallback loader.
   * Non-blocking filesystem access.
   */
  async _loadRoleFromCareerGraph(roleId) {
    try {
      const baseDir = path.join(
        __dirname,
        '..',
        '..',
        'data',
        'career-graph'
      );

      const families = await fs.readdir(baseDir, {
        withFileTypes: true,
      });

      for (const family of families) {
        if (!family.isDirectory()) continue;

        const familyDir = path.join(baseDir, family.name);
        const files = await fs.readdir(familyDir);

        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          const raw = await fs.readFile(
            path.join(familyDir, file),
            'utf8'
          );

          const role = JSON.parse(raw);

          if (role?.role_id === roleId) {
            return role;
          }
        }
      }
    } catch (_) {
      // fallback intentionally silent
    }

    return null;
  }
}

module.exports = ResumeGrowthService;