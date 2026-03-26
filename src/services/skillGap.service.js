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
const cmsRolesRepo = new BaseRepository('cms_roles'); // CMS-created roles live here
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

// ── Built-in role → skill map ─────────────────────────────────────────────────
// Used as fallback when roleSkills collection has no doc for the requested role.
// Keys are substrings matched against the role title (case-insensitive).
const BUILTIN_ROLE_SKILLS = {
  accountant:        ['Accounting','Financial Reporting','Tally','GST Filing','Taxation','Bookkeeping','Excel','Audit','Cost Accounting','Payroll Processing','QuickBooks','SAP Finance'],
  'business analyst':['Requirements Gathering','Process Mapping','SQL','Stakeholder Management','Agile','JIRA','Data Analysis','Excel','Visio','User Stories','MS Project','Power BI'],
  'data analyst':    ['SQL','Python','Excel','Tableau','Power BI','Statistics','Data Cleaning','Data Visualisation','R','ETL','Google Analytics','Looker'],
  'data scientist':  ['Python','Machine Learning','Statistics','SQL','TensorFlow','PyTorch','Feature Engineering','Pandas','Scikit-learn','Deep Learning','NLP','MLOps'],
  'data engineer':   ['Python','Spark','Airflow','dbt','SQL','Kafka','AWS','GCP','BigQuery','ETL','Databricks','Terraform'],
  'software engineer':['Python','JavaScript','TypeScript','React','Node.js','Docker','AWS','Kubernetes','CI/CD','System Design','SQL','Git'],
  'frontend engineer':['React','TypeScript','JavaScript','CSS','HTML','Next.js','Figma','Web Performance','Accessibility','GraphQL','Jest','Webpack'],
  'backend engineer': ['Node.js','Python','Go','Java','SQL','PostgreSQL','Redis','REST APIs','Microservices','Docker','AWS','System Design'],
  'full stack':      ['React','Node.js','TypeScript','PostgreSQL','Docker','AWS','REST APIs','GraphQL','CI/CD','Git','Redis','MongoDB'],
  'devops':          ['Kubernetes','Docker','Terraform','CI/CD','AWS','GCP','Azure','Linux','Bash','Monitoring','Ansible','Helm'],
  'ml engineer':     ['Python','TensorFlow','PyTorch','MLOps','Kubernetes','Docker','AWS','Feature Engineering','SQL','CI/CD','Spark','Apache Beam'],
  'product manager': ['Product Strategy','Roadmapping','Agile','User Research','A/B Testing','SQL','JIRA','Stakeholder Management','OKRs','Data Analysis','Wireframing','Go-to-Market'],
  'ux designer':     ['Figma','User Research','Wireframing','Prototyping','Usability Testing','Design Thinking','Adobe XD','Information Architecture','Accessibility','Sketch','Motion Design','Design Systems'],
  'product designer':['Figma','Prototyping','User Research','Design Thinking','Visual Design','CSS','HTML','Accessibility','Design Systems','Adobe XD','Motion Design','Sketch'],
  'scrum master':    ['Scrum','Kanban','JIRA','Agile Coaching','Facilitation','Retrospectives','Sprint Planning','Conflict Resolution','Confluence','Risk Management','Stakeholder Management','SAFe'],
  'project manager': ['Project Planning','Risk Management','Stakeholder Management','MS Project','Agile','Budgeting','Gantt Charts','Resource Management','PRINCE2','PMP','Communication','Change Management'],
  'sales':           ['Consultative Selling','CRM','Salesforce','Pipeline Management','Cold Outreach','Negotiation','Objection Handling','HubSpot','Account Management','Forecasting','LinkedIn Sales Navigator','Proposal Writing'],
  'hr':              ['Recruitment','Onboarding','Performance Management','HRIS','Compensation & Benefits','Employee Relations','Labour Law','Training & Development','HR Analytics','Conflict Resolution','Payroll','Workday'],
  'finance':         ['Financial Modelling','Excel','Forecasting','Budgeting','Accounting','ERP','Variance Analysis','PowerPoint','SQL','SAP','Cash Flow Management','IFRS'],
  'marketing':       ['Digital Marketing','SEO','Google Ads','Social Media','Content Strategy','Analytics','Email Marketing','HubSpot','Copywriting','A/B Testing','CRM','Brand Strategy'],
  'operations':      ['Process Improvement','Six Sigma','Supply Chain','ERP','Data Analysis','Lean','Project Management','Vendor Management','KPI Tracking','Excel','Risk Management','Logistics'],
  'customer success':['Customer Onboarding','CRM','NPS','Churn Analysis','Product Knowledge','Communication','Upselling','SaaS','Zendesk','SQL','Account Management','Stakeholder Management'],
};

function _getBuiltinSkillsForRole(roleTitle) {
  if (!roleTitle) return [];
  const lower = roleTitle.toLowerCase();
  for (const [key, skills] of Object.entries(BUILTIN_ROLE_SKILLS)) {
    if (lower.includes(key)) {
      return skills.map(name => ({ name, category: 'technical', source: 'builtin' }));
    }
  }
  return [];
}



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

  // ── Priority 1: CareerGraph engine (rich skills with category + demand scores)
  let careerGraph = null;
  try { careerGraph = require('../modules/careerGraph/CareerGraph'); } catch (_) {}
  const graphNode   = careerGraph ? (careerGraph.getRole(roleId) || careerGraph.resolveRole(roleId)) : null;
  const graphSkills = (careerGraph && graphNode) ? careerGraph.getSkillsForRole(roleId) : [];

  if (graphSkills.length > 0) {
    return {
      role:   { id: graphNode.role_id, title: graphNode.title },
      skills: graphSkills.map(s => ({
        name:               s.skill_name,
        category:           s.skill_category,
        importance:         s.importance,
        demand_score:       s.demand_score,
        source:             'career_graph',
      })),
      source: 'career_graph',
    };
  }

  // ── Priority 2: Firestore roleSkills collection (admin-curated overrides)
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

  // ── Priority 3: Firestore roleSkills doc, then BUILTIN_ROLE_SKILLS name map
  const skills = skillDoc?.skills?.length
    ? skillDoc.skills
    : _getBuiltinSkillsForRole(role?.title || role?.name || roleId);

  return {
    role:   { id: role?.id || roleId, title: role?.title || role?.name || roleId },
    skills,
    source: skillDoc ? 'firestore' : 'builtin',
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

  const q = query.trim();

  // ── Strategy 1: Supabase cms_skills ILIKE ────────────────────────────────
  try {
    const supabase = require('../core/supabaseClient');
    let dbQuery = supabase
      .from('cms_skills')
      .select('id, name, category, aliases')
      .ilike('name', `%${q}%`)
      .eq('soft_deleted', false)
      .eq('status', 'active')
      .order('name', { ascending: true })
      .limit(10);

    if (category) dbQuery = dbQuery.eq('category', category);

    const { data, error } = await dbQuery;

    if (error) {
      logger.warn('[SkillGap] cms_skills ILIKE failed', { error: error.message, query: q });
    } else if (data && data.length > 0) {
      return data.map(row => ({
        id:       row.id,
        name:     row.name,
        category: row.category || 'General',
        aliases:  row.aliases  || [],
      }));
    }
  } catch (supaErr) {
    logger.warn('[SkillGap] cms_skills query threw', { error: supaErr.message });
  }

  // ── Strategy 2: cms_skills without status filter (some rows may lack it) ─
  try {
    const supabase = require('../core/supabaseClient');
    let dbQuery = supabase
      .from('cms_skills')
      .select('id, name, category, aliases')
      .ilike('name', `%${q}%`)
      .order('name', { ascending: true })
      .limit(10);

    if (category) dbQuery = dbQuery.eq('category', category);

    const { data, error } = await dbQuery;

    if (!error && data && data.length > 0) {
      return data.map(row => ({
        id:       row.id,
        name:     row.name,
        category: row.category || 'General',
        aliases:  row.aliases  || [],
      }));
    }
    logger.debug('[SkillGap] cms_skills no-filter returned empty', { query: q, error: error?.message });
  } catch (e2) {
    logger.warn('[SkillGap] cms_skills fallback query threw', { error: e2.message });
  }

  // ── Strategy 3: static benchmark list ────────────────────────────────────
  const STATIC_SKILLS = [
    'Advanced Excel','Tally ERP','GST Compliance','Financial Reporting','Tax Planning',
    'Financial Modelling','Cost Accounting','MIS Reporting','Accounts Payable','Bank Reconciliation',
    'React','Node.js','TypeScript','Python','SQL','AWS','Docker','Kubernetes','Git','REST APIs',
    'Machine Learning','TensorFlow','Data Analysis','Tableau','Power BI','Statistics',
    'Digital Marketing','SEO','Google Analytics','Content Strategy','Social Media','Email Marketing',
    'Talent Acquisition','Performance Management','HR Analytics','Payroll Management','HRIS',
    'Project Management','Agile','Scrum','Stakeholder Management','Team Leadership',
    'Figma','UX Design','UI Design','User Research','Wireframing','Prototyping',
    'Salesforce','CRM','B2B Sales','Pipeline Management','Account Management','Negotiation',
    'Budgeting','Forecasting','P&L Management','ERP Systems','Cash Flow','Variance Analysis',
    'Communication','Problem Solving','Critical Thinking','Time Management','Teamwork',
    'Recruitment','Onboarding','Employee Relations','Labour Law','Compensation & Benefits',
    'Inventory Management','Supply Chain','Vendor Management','Lean Six Sigma','Process Improvement',
    'Business Analysis','Requirement Gathering','Gap Analysis','Process Mapping','User Stories',
  ];

  const lower   = q.toLowerCase();
  const matched = STATIC_SKILLS
    .filter(s => s.toLowerCase().includes(lower))
    .slice(0, 10)
    .map((name, i) => ({ id: `static_${i}`, name, category: 'General', aliases: [] }));

  logger.debug('[SkillGap] returning static fallback results', { query: q, count: matched.length });
  return matched;
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








