'use strict';

/**
 * skillGap.service.js
 *
 * CHANGES (remediation sprint):
 *   FIX-12: Added three methods that skills.controller.js calls but were missing:
 *           - searchSkillsByName({ query, category })
 *           - computeBulkGapAnalysis({ targetRoleIds, userSkills })
 *           - getRequiredSkillsForRole(roleId)
 */

const RoleRepository = require('../repositories/RoleRepository');
const BaseRepository = require('../repositories/BaseRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const roleRepo = new RoleRepository();
const roleSkillsRepo = new BaseRepository('roleSkills');
const certificationsRepo = new BaseRepository('certifications');
const skillsRepo = new BaseRepository('skills');

// ─────────────────────────────────────────────
// Skill category weights
// ─────────────────────────────────────────────
const SKILL_WEIGHTS = {
  technical: parseInt(process.env.SKILL_WEIGHT_TECHNICAL || '60'),
  soft: parseInt(process.env.SKILL_WEIGHT_SOFT || '25'),
  domain: parseInt(process.env.SKILL_WEIGHT_DOMAIN || '15'),
};

const PROFICIENCY_ORDINAL = {
  beginner: 1,
  intermediate: 2,
  advanced: 3,
  expert: 4,
};

const normalizeSkillName = (name) =>
  name
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildSkillMap = (skills = []) =>
  skills.reduce((map, skill) => {
    map[normalizeSkillName(skill.name)] = skill;
    return map;
  }, {});

const classifySkillMatch = (userSkill, requiredSkill) => {
  if (!userSkill) return 'missing';

  const userOrdinal = PROFICIENCY_ORDINAL[userSkill.proficiencyLevel] || 2;
  const requiredOrdinal =
    PROFICIENCY_ORDINAL[requiredSkill.minimumProficiency] || 2;

  return userOrdinal >= requiredOrdinal ? 'full' : 'partial';
};

const computeReadinessScore = (requiredSkills, userSkillMap) => {
  const byCategory = { technical: [], soft: [], domain: [] };

  requiredSkills.forEach(skill => {
    const cat = byCategory[skill.category] ? skill.category : 'technical';
    byCategory[cat].push(skill);
  });

  let weightedScore = 0;
  let totalWeight = 0;
  const breakdown = {};

  Object.entries(byCategory).forEach(([category, skills]) => {
    if (skills.length === 0) return;

    const weight = SKILL_WEIGHTS[category] / 100;

    const categoryScore = skills.reduce((sum, skill) => {
      const userSkill = userSkillMap[normalizeSkillName(skill.name)];
      const match = classifySkillMatch(userSkill, skill);
      return sum + (match === 'full' ? 1 : match === 'partial' ? 0.5 : 0);
    }, 0);

    const normalizedScore = (categoryScore / skills.length) * 100;

    breakdown[category] = {
      score: Math.round(normalizedScore),
      matched: Math.round(categoryScore),
      total: skills.length,
    };

    weightedScore += normalizedScore * weight;
    totalWeight += weight;
  });

  const finalScore =
    totalWeight > 0
      ? Math.min(100, Math.round(weightedScore / totalWeight))
      : 0;

  return { score: finalScore, breakdown };
};

const rankMissingSkills = (missingSkills) =>
  [...missingSkills]
    .map(skill => ({
      ...skill,
      priorityScore:
        (skill.criticality || 3) * (skill.roleWeight || 0.5),
    }))
    .sort((a, b) => b.priorityScore - a.priorityScore);

// ─────────────────────────────────────────────
// MAIN GAP ANALYSIS
// ─────────────────────────────────────────────
const computeGapAnalysis = async ({
  targetRoleId,
  userSkills = [],
  includeRecommendations = true,
}) => {
  if (!targetRoleId) {
    throw new AppError(
      'targetRoleId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.debug('[SkillGapService] start', {
    targetRoleId,
    userSkillCount: userSkills.length,
  });

  const [role, skillDoc] = await Promise.all([
    roleRepo.findById(targetRoleId),
    roleSkillsRepo.findById(targetRoleId),
  ]);

  if (!role) {
    throw new AppError(
      `Role '${targetRoleId}' not found`,
      404,
      {},
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  if (!skillDoc) {
    throw new AppError(
      `Skill requirements not configured for role '${targetRoleId}'`,
      404,
      {},
      ErrorCodes.SKILL_DATA_NOT_FOUND
    );
  }

  const requiredSkills = skillDoc.skills || [];

  if (requiredSkills.length === 0) {
    throw new AppError(
      `No required skills defined for role '${targetRoleId}'`,
      422,
      {},
      ErrorCodes.SKILL_DATA_NOT_FOUND
    );
  }

  const userSkillMap = buildSkillMap(userSkills);

  const matchedSkills = [];
  const partialSkills = [];
  const missingSkills = [];

  requiredSkills.forEach(requiredSkill => {
    const normalized = normalizeSkillName(requiredSkill.name);
    const userSkill = userSkillMap[normalized];
    const matchType = classifySkillMatch(userSkill, requiredSkill);

    const enriched = {
      name: requiredSkill.name,
      category: requiredSkill.category || 'technical',
      criticality: requiredSkill.criticality || 3,
      minimumProficiency: requiredSkill.minimumProficiency || 'intermediate',
      userProficiency: userSkill?.proficiencyLevel || null,
    };

    if (matchType === 'full') matchedSkills.push(enriched);
    if (matchType === 'partial')
      partialSkills.push({ ...enriched, gap: 'proficiency' });
    if (matchType === 'missing') missingSkills.push(enriched);
  });

  const matchPercentage = Math.round(
    ((matchedSkills.length + partialSkills.length * 0.5) /
      requiredSkills.length) *
      100
  );

  const { score: readinessScore, breakdown } =
    computeReadinessScore(requiredSkills, userSkillMap);

  const readinessCategory =
    readinessScore >= 80
      ? 'ready'
      : readinessScore >= 60
      ? 'nearly_ready'
      : readinessScore >= 40
      ? 'developing'
      : 'early_stage';

  const rankedMissing = rankMissingSkills(missingSkills);

  let recommendations = null;

  if (includeRecommendations && rankedMissing.length > 0) {
    const top = rankedMissing.slice(0, 5);

    recommendations = await Promise.all(
      top.map(async skill => {
        const result = await certificationsRepo.find(
          [
            {
              field: 'relatedSkills',
              op: 'array-contains',
              value: skill.name.toLowerCase(),
            },
          ],
          { limit: 2 }
        );

        return {
          skill: skill.name,
          certifications: result.docs.map(doc => ({
            id: doc.id,
            title: doc.title,
            provider: doc.provider,
            url: doc.url,
          })),
        };
      })
    );
  }

  return {
    targetRole: {
      id: role.id,
      title: role.title,
      level: role.level,
      jobFamily: role.jobFamilyId,
    },
    matchPercentage,
    readinessScore,
    readinessCategory,
    skillsSummary: {
      totalRequired: requiredSkills.length,
      matched: matchedSkills.length,
      partial: partialSkills.length,
      missing: missingSkills.length,
    },
    matchedSkills,
    partialSkills,
    missingSkills: rankedMissing,
    scoreBreakdown: breakdown,
    recommendations,
  };
};

// ─────────────────────────────────────────────
// FIX-12: GET REQUIRED SKILLS FOR ROLE
// Called by: skillsController.getRoleSkills
// ─────────────────────────────────────────────
const getRequiredSkillsForRole = async (roleId) => {
  if (!roleId) {
    throw new AppError('roleId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const [role, skillDoc] = await Promise.all([
    roleRepo.findById(roleId),
    roleSkillsRepo.findById(roleId),
  ]);

  if (!role) {
    throw new AppError(
      `Role '${roleId}' not found`,
      404,
      {},
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  if (!skillDoc) {
    throw new AppError(
      `Skill requirements not configured for role '${roleId}'`,
      404,
      {},
      ErrorCodes.SKILL_DATA_NOT_FOUND
    );
  }

  return {
    role: { id: role.id, title: role.title },
    skills: skillDoc.skills || [],
  };
};

// ─────────────────────────────────────────────
// FIX-12: SEARCH SKILLS BY NAME
// Called by: skillsController.searchSkills
// ─────────────────────────────────────────────
const searchSkillsByName = async ({ query, category } = {}) => {
  if (!query || query.trim().length < 2) {
    throw new AppError(
      'Search query must be at least 2 characters',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const normalizedQuery = normalizeSkillName(query);

  const filters = [];
  if (category) {
    filters.push({ field: 'category', op: '==', value: category });
  }

  const result = await skillsRepo.find(filters, { limit: 50 });

  // Client-side name filtering since Firestore doesn't support LIKE queries
  const matched = result.docs.filter(skill =>
    normalizeSkillName(skill.name || '').includes(normalizedQuery)
  );

  return matched.map(skill => ({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    aliases: skill.aliases || [],
  }));
};

// ─────────────────────────────────────────────
// FIX-12: BULK GAP ANALYSIS
// Called by: skillsController.bulkGapAnalysis
// ─────────────────────────────────────────────
const computeBulkGapAnalysis = async ({ targetRoleIds, userSkills = [] }) => {
  if (!Array.isArray(targetRoleIds) || targetRoleIds.length === 0) {
    throw new AppError(
      'targetRoleIds must be a non-empty array',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.debug('[SkillGapService] bulkGapAnalysis start', {
    roleCount: targetRoleIds.length,
    userSkillCount: userSkills.length,
  });

  const results = await Promise.all(
    targetRoleIds.map(roleId =>
      computeGapAnalysis({ targetRoleId: roleId, userSkills, includeRecommendations: false })
        .catch(err => ({
          targetRoleId: roleId,
          error: err.message,
          unavailable: true,
        }))
    )
  );

  const successful = results.filter(r => !r.unavailable);
  const failed = results.filter(r => r.unavailable);

  // Sort by readinessScore descending so best matches come first
  successful.sort((a, b) => (b.readinessScore || 0) - (a.readinessScore || 0));

  return {
    results: successful,
    unavailableRoles: failed.map(f => f.targetRoleId),
    meta: {
      totalRequested: targetRoleIds.length,
      totalSucceeded: successful.length,
      totalFailed: failed.length,
    },
  };
};

module.exports = {
  computeGapAnalysis,
  getRequiredSkillsForRole, // FIX-12
  searchSkillsByName,       // FIX-12
  computeBulkGapAnalysis,   // FIX-12
};