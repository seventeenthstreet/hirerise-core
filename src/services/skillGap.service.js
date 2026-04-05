'use strict';

/**
 * skillGap.service.js
 *
 * Production-ready Supabase-aligned skill gap analysis service
 * FIX-12 remediation fully integrated
 */

const RoleRepository = require('../repositories/RoleRepository');
const BaseRepository = require('../repositories/BaseRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const supabase = require('../config/supabase');

const roleRepo = new RoleRepository();
const cmsRolesRepo = new BaseRepository('cms_roles');
const roleSkillsRepo = new BaseRepository('role_skills');
const certificationsRepo = new BaseRepository('certifications');

const SKILL_WEIGHTS = {
  technical: parseInt(process.env.SKILL_WEIGHT_TECHNICAL || '60', 10),
  soft: parseInt(process.env.SKILL_WEIGHT_SOFT || '25', 10),
  domain: parseInt(process.env.SKILL_WEIGHT_DOMAIN || '15', 10),
};

const PROFICIENCY_ORDINAL = {
  beginner: 1,
  intermediate: 2,
  advanced: 3,
  expert: 4,
};

const STATIC_SKILLS = [
  'Advanced Excel', 'Tally ERP', 'GST Compliance', 'Financial Reporting',
  'Tax Planning', 'Financial Modelling', 'Cost Accounting', 'MIS Reporting',
  'Accounts Payable', 'Bank Reconciliation', 'React', 'Node.js',
  'TypeScript', 'Python', 'SQL', 'AWS', 'Docker', 'Kubernetes', 'Git',
  'REST APIs', 'Machine Learning', 'TensorFlow', 'Data Analysis',
  'Tableau', 'Power BI', 'Statistics', 'Digital Marketing', 'SEO',
  'Google Analytics', 'Content Strategy', 'Social Media',
  'Email Marketing', 'Talent Acquisition', 'Performance Management',
  'HR Analytics', 'Payroll Management', 'HRIS', 'Project Management',
  'Agile', 'Scrum', 'Stakeholder Management', 'Team Leadership',
  'Figma', 'UX Design', 'UI Design', 'User Research',
  'Wireframing', 'Prototyping', 'Salesforce', 'CRM',
  'B2B Sales', 'Pipeline Management', 'Account Management',
  'Negotiation', 'Budgeting', 'Forecasting', 'P&L Management',
  'ERP Systems', 'Cash Flow', 'Variance Analysis', 'Communication',
  'Problem Solving', 'Critical Thinking', 'Time Management',
  'Teamwork', 'Recruitment', 'Onboarding', 'Employee Relations',
  'Labour Law', 'Compensation & Benefits', 'Inventory Management',
  'Supply Chain', 'Vendor Management', 'Lean Six Sigma',
  'Process Improvement', 'Business Analysis', 'Requirement Gathering',
  'Gap Analysis', 'Process Mapping', 'User Stories',
];

const normalizeSkillName = (name = '') =>
  String(name)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildSkillMap = (skills = []) =>
  skills.reduce((map, skill) => {
    if (skill?.name) {
      map[normalizeSkillName(skill.name)] = skill;
    }
    return map;
  }, {});

/**
 * Normalise repository results to a plain array.
 * Handles three shapes:
 *   - plain array          (BaseRepository returns rows directly)
 *   - { data: [] }         (Supabase client response shape)
 *   - { rows: [] }         (legacy / custom wrapper)
 */
const normalizeRepoRows = (result) => {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
};

const classifySkillMatch = (userSkill, requiredSkill) => {
  if (!userSkill) return 'missing';

  const userOrdinal = PROFICIENCY_ORDINAL[userSkill.proficiencyLevel] || 2;
  const requiredOrdinal =
    PROFICIENCY_ORDINAL[requiredSkill.minimumProficiency] || 2;

  return userOrdinal >= requiredOrdinal ? 'full' : 'partial';
};

const computeReadinessScore = (requiredSkills, userSkillMap) => {
  const byCategory = { technical: [], soft: [], domain: [] };

  requiredSkills.forEach((skill) => {
    const category = byCategory[skill.category] ? skill.category : 'technical';
    byCategory[category].push(skill);
  });

  let weightedScore = 0;
  let totalWeight = 0;
  const breakdown = {};

  Object.entries(byCategory).forEach(([category, skills]) => {
    if (!skills.length) return;

    const weight = SKILL_WEIGHTS[category] / 100;

    const score = skills.reduce((sum, skill) => {
      const userSkill = userSkillMap[normalizeSkillName(skill.name)];
      const match = classifySkillMatch(userSkill, skill);
      return sum + (match === 'full' ? 1 : match === 'partial' ? 0.5 : 0);
    }, 0);

    const normalizedScore = (score / skills.length) * 100;

    breakdown[category] = {
      score: Math.round(normalizedScore),
      matched: Math.round(score),
      total: skills.length,
    };

    weightedScore += normalizedScore * weight;
    totalWeight += weight;
  });

  return {
    score:
      totalWeight > 0
        ? Math.min(100, Math.round(weightedScore / totalWeight))
        : 0,
    breakdown,
  };
};

const rankMissingSkills = (missingSkills = []) =>
  [...missingSkills]
    .map((skill) => ({
      ...skill,
      priorityScore:
        (skill.criticality || 3) * (skill.roleWeight || 0.5),
    }))
    .sort((a, b) => b.priorityScore - a.priorityScore);

const fetchCertificationRecommendations = async (skills = []) =>
  Promise.all(
    skills.map(async (skill) => {
      const result = await certificationsRepo.find(
        [
          {
            field: 'related_skills',
            op:    'contains',        // Supabase/PostgREST array contains operator
            value: skill.name.toLowerCase(),
          },
        ],
        { limit: 2 }
      );

      const rows = normalizeRepoRows(result);

      return {
        skill: skill.name,
        certifications: rows.map((row) => ({
          id:       row.id,
          title:    row.title,
          provider: row.provider,
          url:      row.url,
        })),
      };
    })
  );

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

  const requiredSkills = skillDoc?.skills || [];

  if (!requiredSkills.length) {
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

  requiredSkills.forEach((requiredSkill) => {
    const userSkill =
      userSkillMap[normalizeSkillName(requiredSkill.name)];
    const matchType = classifySkillMatch(userSkill, requiredSkill);

    const enriched = {
      name: requiredSkill.name,
      category: requiredSkill.category || 'technical',
      criticality: requiredSkill.criticality || 3,
      minimumProficiency:
        requiredSkill.minimumProficiency || 'intermediate',
      userProficiency: userSkill?.proficiencyLevel || null,
    };

    if (matchType === 'full') matchedSkills.push(enriched);
    else if (matchType === 'partial')
      partialSkills.push({ ...enriched, gap: 'proficiency' });
    else missingSkills.push(enriched);
  });

  const { score: readinessScore, breakdown } =
    computeReadinessScore(requiredSkills, userSkillMap);

  const rankedMissing = rankMissingSkills(missingSkills);

  const recommendations =
    includeRecommendations && rankedMissing.length
      ? await fetchCertificationRecommendations(
          rankedMissing.slice(0, 5)
        )
      : null;

  return {
    targetRole: {
      id: role.id,
      title: role.title,
      level: role.level,
      jobFamily: role.jobFamilyId,
    },
    readinessScore,
    scoreBreakdown: breakdown,
    matchedSkills,
    partialSkills,
    missingSkills: rankedMissing,
    recommendations,
  };
};

const getRequiredSkillsForRole = async (roleId) => {
  if (!roleId) {
    throw new AppError(
      'roleId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const [rolePrimary, cmsRole, skillDoc] = await Promise.all([
    roleRepo.findById(roleId),
    cmsRolesRepo.findById(roleId),
    roleSkillsRepo.findById(roleId),
  ]);

  const role = rolePrimary || cmsRole;

  if (!role && !skillDoc) {
    throw new AppError(
      `Role '${roleId}' not found`,
      404,
      {},
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  return {
    role: {
      id: role?.id || roleId,
      title: role?.title || role?.name || roleId,
    },
    skills: skillDoc?.skills || [],
    source: skillDoc ? 'supabase' : 'none',
  };
};

const searchSkillsByName = async ({ query, category } = {}) => {
  if (!query || query.trim().length < 2) {
    throw new AppError(
      'Search query must be at least 2 characters',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const q = query.trim();

  try {
    let dbQuery = supabase
      .from('cms_skills')
      .select('id, name, category, aliases')
      .ilike('name', `%${q}%`)
      .order('name', { ascending: true })
      .limit(10);

    if (category) {
      dbQuery = dbQuery.eq('category', category);
    }

    const { data, error } = await dbQuery;

    if (!error && Array.isArray(data) && data.length > 0) {
      return data.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category || 'General',
        aliases: row.aliases || [],
      }));
    }
  } catch (error) {
    logger.warn('[SkillGap] searchSkillsByName failed', {
      query: q,
      error: error.message,
    });
  }

  return STATIC_SKILLS
    .filter((skill) =>
      skill.toLowerCase().includes(q.toLowerCase())
    )
    .slice(0, 10)
    .map((name, index) => ({
      id: `static_${index}`,
      name,
      category: 'General',
      aliases: [],
    }));
};

const computeBulkGapAnalysis = async ({
  targetRoleIds,
  userSkills = [],
}) => {
  if (!Array.isArray(targetRoleIds) || !targetRoleIds.length) {
    throw new AppError(
      'targetRoleIds must be a non-empty array',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const results = await Promise.all(
    targetRoleIds.map((roleId) =>
      computeGapAnalysis({
        targetRoleId: roleId,
        userSkills,
        includeRecommendations: false,
      }).catch((error) => ({
        targetRoleId: roleId,
        error: error.message,
        unavailable: true,
      }))
    )
  );

  const successful = results
    .filter((result) => !result.unavailable)
    .sort(
      (a, b) => (b.readinessScore || 0) - (a.readinessScore || 0)
    );

  const failed = results.filter((result) => result.unavailable);

  return {
    results: successful,
    unavailableRoles: failed.map((r) => r.targetRoleId),
    meta: {
      totalRequested: targetRoleIds.length,
      totalSucceeded: successful.length,
      totalFailed: failed.length,
    },
  };
};

module.exports = {
  computeGapAnalysis,
  getRequiredSkillsForRole,
  searchSkillsByName,
  computeBulkGapAnalysis,
};