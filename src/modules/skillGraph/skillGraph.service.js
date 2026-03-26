'use strict';

/**
 * skillGraph.service.js — Skill Graph Intelligence Service
 *
 * Application-layer service wrapping the SkillGraph engine.
 * Handles caching, input validation, and response shaping for controllers.
 *
 * Consumed by:
 *   - skillGraph.controller.js   (HTTP API)
 *   - skillGap.service.js        (enriched gap analysis)
 *   - CareerGraph.js             (CHI skill score)
 *   - onboarding services        (learning path cards)
 */

const skillGraph = require('./SkillGraph');
const logger     = require('../../utils/logger');

// Simple in-process cache (TTL: 30 min)
const _cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function _get(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.val;
}
function _set(key, val) {
  _cache.set(key, { val, ts: Date.now() });
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value);
}

// ─── Skill lookup ─────────────────────────────────────────────────────────────

async function getSkill(skillId) {
  return skillGraph.getSkill(skillId);
}

async function getAllSkills({ category, limit = 200 } = {}) {
  const key = `all:${category || 'all'}:${limit}`;
  const cached = _get(key);
  if (cached) return cached;
  const result = category
    ? skillGraph.getSkillsByCategory(category).slice(0, limit)
    : skillGraph.allSkills().slice(0, limit);
  _set(key, result);
  return result;
}

async function searchSkills(query, opts = {}) {
  if (!query || String(query).trim().length < 2) return [];
  return skillGraph.searchSkills(query, opts);
}

// ─── Relationships ────────────────────────────────────────────────────────────

async function getRelationships(skillId, type = null) {
  if (!skillId) throw new Error('skillId is required');
  return skillGraph.getRelationships(skillId, type);
}

async function getPrerequisites(skillId, deep = true) {
  if (!skillId) throw new Error('skillId is required');
  const key = `prereq:${skillId}:${deep}`;
  const cached = _get(key);
  if (cached) return cached;
  const result = skillGraph.getPrerequisites(skillId, deep);
  _set(key, result);
  return result;
}

async function getAdvancedSkills(skillId) {
  if (!skillId) throw new Error('skillId is required');
  return skillGraph.getAdvancedSkills(skillId);
}

async function getRelatedSkills(skillId) {
  if (!skillId) throw new Error('skillId is required');
  return skillGraph.getRelatedSkills(skillId);
}

// ─── Role skill map ───────────────────────────────────────────────────────────

async function getRoleSkillMap(roleId) {
  if (!roleId) throw new Error('roleId is required');
  const key = `role:${roleId}`;
  const cached = _get(key);
  if (cached) return cached;
  const result = skillGraph.getRoleSkillMap(roleId);
  _set(key, result);
  return result;
}

// ─── Built-in role → skills dictionary ───────────────────────────────────────
// FIX: SkillGraph only loads role skills from JSON files in career-graph/.
// For any role not covered by a JSON file (every role not manually created),
// getRoleSkillMap() returns empty arrays → detectGap always shows 0% match.
//
// This dictionary covers the most common Indian job market roles and is used
// as a fallback when the career-graph JSON files have no entry for a role.
// It scales to thousands of roles without needing individual JSON files.
// Skill names match _normaliseUserSkills() which adds both display name and
// underscore-slug form to the lookup set.

const ROLE_SKILL_FALLBACKS = {
  // ── Finance & Accounting ──────────────────────────────────────────────────
  'Accountant': {
    required:  ['Tally ERP','GST','Excel','Financial Reporting','TDS','Accounts Payable','Accounts Receivable','Bank Reconciliation','Taxation','MIS Reporting'],
    preferred: ['Zoho Books','QuickBooks','Budgeting','Payroll Processing','Audit','Forecasting','Compliance'],
  },
  'Senior Accountant': {
    required:  ['Tally ERP','GST','Excel','Financial Reporting','TDS','Budgeting','Forecasting','MIS Reporting','Payroll Processing','Accounts Payable','Accounts Receivable'],
    preferred: ['QuickBooks','Zoho Books','Compliance','Audit','Financial Modelling'],
  },
  'Junior Accountant': {
    required:  ['Tally ERP','GST','Excel','Bank Reconciliation','Accounts Payable','Accounts Receivable'],
    preferred: ['TDS','Financial Reporting','Zoho Books'],
  },
  'Tax Consultant': {
    required:  ['GST','TDS','Taxation','Excel','Tally ERP','Financial Reporting'],
    preferred: ['Audit','Budgeting','MIS Reporting','Compliance','Bank Reconciliation'],
  },
  'Financial Analyst': {
    required:  ['Excel','Financial Reporting','Budgeting','Forecasting','MIS Reporting','Financial Modelling'],
    preferred: ['Python','Power BI','Tableau','SQL','Financial Planning'],
  },
  'Finance Manager': {
    required:  ['Financial Reporting','Budgeting','Forecasting','Compliance','MIS Reporting','Excel'],
    preferred: ['GST','TDS','Payroll Processing','Audit','Team Management'],
  },
  'Auditor': {
    required:  ['Audit','Compliance','Financial Reporting','Excel','Tally ERP','Bank Reconciliation'],
    preferred: ['GST','TDS','Risk Assessment','Internal Controls'],
  },
  'Chartered Accountant': {
    required:  ['Audit','Taxation','Financial Reporting','GST','TDS','Compliance','Excel'],
    preferred: ['Tally ERP','Financial Modelling','Budgeting','MIS Reporting'],
  },
  'Cost Accountant': {
    required:  ['Cost Accounting','Financial Reporting','Excel','Budgeting','MIS Reporting'],
    preferred: ['Tally ERP','SAP','Variance Analysis'],
  },

  // ── Software Engineering ──────────────────────────────────────────────────
  'Software Engineer': {
    required:  ['JavaScript','Python','SQL','Git','REST APIs'],
    preferred: ['Node.js','React','Docker','AWS','System Design'],
  },
  'Senior Software Engineer': {
    required:  ['System Design','JavaScript','Python','SQL','Git','REST APIs','Code Review'],
    preferred: ['Microservices','Docker','Kubernetes','AWS','Mentoring'],
  },
  'Frontend Developer': {
    required:  ['JavaScript','React','HTML','CSS','Git','TypeScript'],
    preferred: ['Next.js','Redux','Webpack','Jest','Figma'],
  },
  'Backend Developer': {
    required:  ['Node.js','Python','SQL','REST APIs','Git'],
    preferred: ['Docker','Redis','PostgreSQL','AWS','GraphQL'],
  },
  'Full Stack Developer': {
    required:  ['JavaScript','React','Node.js','SQL','Git','REST APIs'],
    preferred: ['TypeScript','Docker','AWS','MongoDB'],
  },
  'Data Analyst': {
    required:  ['SQL','Excel','Python','Power BI','Data Analysis'],
    preferred: ['Tableau','R','Machine Learning','Statistics'],
  },
  'Data Scientist': {
    required:  ['Python','Machine Learning','SQL','Statistics','TensorFlow'],
    preferred: ['R','NLP','Deep Learning','Spark','AWS'],
  },
  'Data Engineer': {
    required:  ['Python','SQL','Spark','Airflow','AWS'],
    preferred: ['Kafka','Scala','Docker','dbt','Snowflake'],
  },
  'DevOps Engineer': {
    required:  ['Docker','Kubernetes','AWS','Linux','CI/CD','Git'],
    preferred: ['Terraform','Ansible','Python','Monitoring','Helm'],
  },
  'Cloud Engineer': {
    required:  ['AWS','Azure','Terraform','Linux','Docker'],
    preferred: ['Kubernetes','Python','CI/CD','Networking'],
  },
  'QA Engineer': {
    required:  ['Manual Testing','Selenium','SQL','JIRA','Test Cases'],
    preferred: ['Automation Testing','Python','API Testing','Postman'],
  },
  'Mobile Developer': {
    required:  ['React Native','JavaScript','Git','REST APIs'],
    preferred: ['iOS','Android','Flutter','TypeScript','Firebase'],
  },

  // ── Management ────────────────────────────────────────────────────────────
  'Product Manager': {
    required:  ['Product Management','Agile','Scrum','Roadmap','Stakeholder Management'],
    preferred: ['JIRA','SQL','User Research','A/B Testing','Data Analysis'],
  },
  'Engineering Manager': {
    required:  ['Leadership','Agile','System Design','Code Review','Scrum','Team Management'],
    preferred: ['Hiring','Budgeting','OKRs','Architecture','Mentoring'],
  },
  'Project Manager': {
    required:  ['Project Management','Agile','Scrum','Risk Management','Stakeholder Management'],
    preferred: ['JIRA','MS Project','Budgeting','PMP','Communication'],
  },
  'Operations Manager': {
    required:  ['Operations Management','Process Improvement','Excel','Reporting','Leadership'],
    preferred: ['ERP','Supply Chain','Budgeting','Six Sigma','Team Management'],
  },

  // ── HR ────────────────────────────────────────────────────────────────────
  'HR Manager': {
    required:  ['Recruitment','Payroll','Compliance','Excel','Communication','Labor Law'],
    preferred: ['HRMS','Performance Management','Training','Employee Engagement'],
  },
  'HR Executive': {
    required:  ['Recruitment','Onboarding','Excel','Communication','HRMS'],
    preferred: ['Payroll','Labor Law','Employee Engagement'],
  },
  'Recruiter': {
    required:  ['Recruitment','Sourcing','LinkedIn','Communication','Interviewing'],
    preferred: ['ATS','Boolean Search','Employer Branding','HR Analytics'],
  },

  // ── Marketing ─────────────────────────────────────────────────────────────
  'Digital Marketing Specialist': {
    required:  ['SEO','Google Analytics','Facebook Ads','Content Marketing','Excel'],
    preferred: ['Google Ads','Email Marketing','CRM','Social Media','Copywriting'],
  },
  'Marketing Manager': {
    required:  ['Marketing Strategy','SEO','Google Analytics','Team Management','Budgeting'],
    preferred: ['CRM','Brand Management','Performance Marketing','Content Strategy'],
  },
  'Content Writer': {
    required:  ['Content Writing','SEO','Research','Communication','MS Word'],
    preferred: ['WordPress','Social Media','Copywriting','Editing'],
  },

  // ── Sales ─────────────────────────────────────────────────────────────────
  'Sales Executive': {
    required:  ['Sales','Communication','CRM','Negotiation','Excel'],
    preferred: ['Cold Calling','B2B Sales','Lead Generation','Presentation'],
  },
  'Sales Manager': {
    required:  ['Sales Management','CRM','Team Management','Forecasting','Negotiation'],
    preferred: ['B2B Sales','Key Account Management','Salesforce','Reporting'],
  },
  'Business Development Manager': {
    required:  ['Business Development','Communication','CRM','Negotiation','Presentation'],
    preferred: ['Market Research','Partnership Management','Excel'],
  },

  // ── Design ────────────────────────────────────────────────────────────────
  'UI/UX Designer': {
    required:  ['Figma','User Research','Prototyping','Wireframing','Adobe XD'],
    preferred: ['CSS','HTML','User Testing','Design Systems','Sketch'],
  },
  'Graphic Designer': {
    required:  ['Adobe Photoshop','Adobe Illustrator','Typography','Brand Design','Color Theory'],
    preferred: ['Figma','After Effects','InDesign','Motion Graphics'],
  },

  // ── Healthcare ────────────────────────────────────────────────────────────
  'Doctor': {
    required:  ['Clinical Diagnosis','Patient Care','Medical Records','Communication'],
    preferred: ['Research','MBBS','Surgery','EMR Systems'],
  },
  'Nurse': {
    required:  ['Patient Care','Clinical Skills','Communication','Medical Records','IV Administration'],
    preferred: ['Emergency Care','Ward Management','ICU','Pharmacology'],
  },

  // ── Legal ─────────────────────────────────────────────────────────────────
  'Lawyer': {
    required:  ['Legal Research','Contract Drafting','Litigation','Communication','Legal Writing'],
    preferred: ['Corporate Law','Tax Law','Arbitration','Due Diligence'],
  },
  'Compliance Officer': {
    required:  ['Compliance','Risk Management','Regulatory Affairs','Reporting','Excel'],
    preferred: ['Legal Research','Audit','Communication','Financial Regulations'],
  },
};

// ─── Gap detection ────────────────────────────────────────────────────────────

async function detectGap(userSkills, roleId) {
  if (!roleId) throw new Error('roleId is required');
  if (!Array.isArray(userSkills)) throw new Error('userSkills must be an array');

  // Try career-graph JSON files first (existing behaviour)
  let result = skillGraph.detectGap(userSkills, roleId);

  // FIX: If the career-graph has no role JSON for this role (required=[]),
  // fall back to ROLE_SKILL_FALLBACKS dictionary. This covers all roles
  // without needing individual JSON files for each one.
  if (result.required_total === 0) {
    const fallback = ROLE_SKILL_FALLBACKS[roleId];
    if (fallback) {
      const userSet = new Set(
        userSkills.flatMap(s => {
          const name = (typeof s === 'string' ? s : s?.name || '').toLowerCase().trim();
          return [name, name.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')];
        })
      );

      const matched          = [];
      const missing_required = [];
      const missing_preferred = [];

      for (const skillName of (fallback.required || [])) {
        const norm = skillName.toLowerCase().trim();
        const slug = norm.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const has  = userSet.has(norm) || userSet.has(slug) ||
                     [...userSet].some(u => u.length > 3 && (norm.includes(u) || u.includes(norm)));
        const entry = { skill_id: slug, skill: { skill_id: slug, skill_name: skillName }, importance_weight: 1.0 };
        if (has) matched.push(entry);
        else     missing_required.push(entry);
      }

      for (const skillName of (fallback.preferred || [])) {
        const norm = skillName.toLowerCase().trim();
        const slug = norm.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const has  = userSet.has(norm) || userSet.has(slug) ||
                     [...userSet].some(u => u.length > 3 && (norm.includes(u) || u.includes(norm)));
        if (!has) {
          missing_preferred.push({ skill_id: slug, skill: { skill_id: slug, skill_name: skillName }, importance_weight: 0.5 });
        }
      }

      const required_total = matched.length + missing_required.length;
      const match_pct = required_total > 0
        ? Math.round((matched.length / required_total) * 100)
        : 0;

      result = {
        role_id:            roleId,
        matched_skills:     matched,
        missing_required,
        missing_preferred,
        priority_missing:   [...missing_required].slice(0, 8),
        required_match_pct: match_pct,
        skill_score:        match_pct,
        coverage_label:     match_pct >= 80 ? 'strong' : match_pct >= 60 ? 'moderate' : match_pct >= 40 ? 'partial' : 'low',
        required_total,
        matched_count:      matched.length,
        _source:            'fallback_dictionary',
      };
    }
  }

  logger.debug('[SkillGraphService] detectGap', {
    roleId,
    userCount:  userSkills.length,
    matchPct:   result.required_match_pct,
    missingCnt: result.missing_required.length,
    source:     result._source || 'career_graph',
  });

  return result;
}

// ─── Learning paths ───────────────────────────────────────────────────────────

async function generateLearningPath(targetSkillId, userSkills = []) {
  if (!targetSkillId) throw new Error('targetSkillId is required');
  return skillGraph.generateLearningPath(targetSkillId, userSkills);
}

async function generateLearningPaths(userSkills, roleId) {
  if (!roleId) throw new Error('roleId is required');

  const gap = skillGraph.detectGap(userSkills, roleId);
  if (!gap.priority_missing.length) {
    return {
      paths: [],
      global_learning_plan: [],
      total_skills_to_learn: 0,
      estimated_weeks: 0,
      estimated_months: 0,
      message: 'No missing required skills — user meets role requirements.',
    };
  }

  const result = skillGraph.generateLearningPaths(gap.priority_missing, userSkills);

  logger.debug('[SkillGraphService] generateLearningPaths', {
    roleId,
    totalSteps:    result.total_skills_to_learn,
    estimatedWeeks: result.estimated_weeks,
  });

  return result;
}

// ─── CHI skill score ──────────────────────────────────────────────────────────

async function computeSkillScore(userSkills, roleId, weight = 0.30) {
  if (!roleId) throw new Error('roleId is required');
  return skillGraph.computeSkillScore(userSkills, roleId, weight);
}

/**
 * Full skill intelligence report for a user + role combination.
 * Returns gap + learning paths + CHI score in one call.
 * Used by onboarding insight cards and career report enrichment.
 */
async function getSkillIntelligence(userSkills, roleId, opts = {}) {
  const { weight = 0.30, country = 'IN' } = opts;

  const [gap, learningPaths, skillScore] = await Promise.all([
    detectGap(userSkills, roleId),
    generateLearningPaths(userSkills, roleId),
    computeSkillScore(userSkills, roleId, weight),
  ]);

  return {
    role_id:        roleId,
    gap_analysis:   gap,
    learning_paths: learningPaths,
    skill_score:    skillScore,
    summary: {
      match_pct:         gap.required_match_pct,
      coverage_label:    gap.coverage_label,
      missing_count:     gap.missing_required.length,
      top_missing:       gap.priority_missing.slice(0, 3).map(e => e.skill?.skill_name || e.skill_id),
      estimated_months:  learningPaths.estimated_months || 0,
      chi_contribution:  skillScore.weighted_contribution,
    },
  };
}

module.exports = {
  getSkill,
  getAllSkills,
  searchSkills,
  getRelationships,
  getPrerequisites,
  getAdvancedSkills,
  getRelatedSkills,
  getRoleSkillMap,
  detectGap,
  generateLearningPath,
  generateLearningPaths,
  computeSkillScore,
  getSkillIntelligence,
};








