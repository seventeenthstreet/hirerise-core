'use strict';

const fs = require('fs');
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
} = require('./resumeGrowth.engine.js');

class ResumeGrowthService {
  constructor({ roleRepository, skillRepository, resumeGrowthRepository }) {
    this._roleRepo   = roleRepository;
    this._skillRepo  = skillRepository;
    this._growthRepo = resumeGrowthRepository;
  }

  async analyze({ userId, roleId, resume, persist = true }) {

    // 1. Fetch role (primary repository)
    let roleContext = await this._roleRepo.findById(roleId);

    // 🔁 SAFE FALLBACK: load from career-graph if repo is not wired yet
    if (!roleContext) {
      roleContext = this._loadRoleFromCareerGraph(roleId);
    }

    if (!roleContext) {
      const err = new Error(`Role not found: ${roleId}`);
      err.status = 404;
      throw err;
    }

    // 2. Normalize skills
    const normalizedSkills = await this._normalizeSkills(resume.skills || []);

    // 3. Attach durations
    const experience = attachDurations(resume.experience || []);
    const totalYears = this._computeTotalYears(
      experience,
      resume.total_experience_years
    );

    const requiredSkills  = roleContext.required_skills  || [];
    const preferredSkills = roleContext.preferred_skills || [];

    // 4. Run engine (pure)
    const skillCoverage        = calculateSkillCoverage(
      normalizedSkills,
      requiredSkills,
      preferredSkills
    );

    const skillGapAreas        = findSkillGaps(
      normalizedSkills,
      requiredSkills
    );

    const experienceDepthScore = calculateExperienceDepth(
      experience,
      totalYears,
      roleContext
    );

    const educationAlignment   = calculateEducationAlignment(
      resume.education      || [],
      resume.certifications || []
    );

    const currentLevelEstimate     = estimateLevel(totalYears, skillCoverage);
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

    if (persist && userId) {
      await this._growthRepo.save(userId, roleId, signal);
    }

    return signal;
  }

  async getLatest(userId, roleId) {
    return this._growthRepo.getLatest(userId, roleId);
  }

  async _normalizeSkills(rawSkills) {
    const allSkills = await this._skillRepo.getAllWithAliases();

    const aliasMap = new Map();

    for (const skill of allSkills) {
      const canonical = skill.name.toLowerCase();
      aliasMap.set(canonical, canonical);

      for (const alias of skill.aliases || []) {
        aliasMap.set(alias.toLowerCase(), canonical);
      }
    }

    const normalized = new Set();

    for (const raw of rawSkills) {
      const key = (typeof raw === 'string' ? raw : raw.name || '')
        .trim()
        .toLowerCase();

      if (key) {
        normalized.add(aliasMap.get(key) || key);
      }
    }

    return [...normalized];
  }

  _computeTotalYears(experience, providedYears) {
    if (typeof providedYears === 'number') return providedYears;

    const totalMonths = experience.reduce(
      (sum, e) => sum + (e.duration_months || 0),
      0
    );

    return Math.round((totalMonths / 12) * 10) / 10;
  }

  // 🔧 INTERNAL FALLBACK (NO SIDE EFFECTS)
  _loadRoleFromCareerGraph(roleId) {
    try {
      const baseDir = path.join(
        __dirname,
        '..',
        '..',
        'data',
        'career-graph'
      );

      const families = fs.readdirSync(baseDir, { withFileTypes: true });

      for (const family of families) {
        if (!family.isDirectory()) continue;

        const familyDir = path.join(baseDir, family.name);
        const files = fs.readdirSync(familyDir);

        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          const role = JSON.parse(
            fs.readFileSync(path.join(familyDir, file), 'utf8')
          );

          if (role?.role_id === roleId) {
            return role;
          }
        }
      }
    } catch (_) {
      // intentionally silent — fallback only
    }

    return null;
  }
}

module.exports = ResumeGrowthService;








