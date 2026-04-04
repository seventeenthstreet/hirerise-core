'use strict';

/**
 * skillRecommendations.service.js
 * Location: src/modules/skillDemand/
 *
 * Personalized skill recommendation engine:
 * - live benchmark skills from dataset
 * - role fallback benchmarks
 * - user profile enrichment
 * - demand-ranked missing skills
 */

const logger = require('../../utils/logger');
const { supabase } = require('../../config/supabase');

const {
  loadDatasets,
  lookupRoleSkills,
  lookupSkillDemand,
} = require('./repository/skillDemandDataset');

const DEFAULT_DEMAND_SCORE = 60;
const MAX_RECOMMENDATIONS = 6;
const MIN_LIVE_BENCHMARK_COUNT = 3;

const ROLE_BENCHMARKS = {
  accountant: ['Advanced Excel', 'Tally ERP', 'GST Compliance', 'Financial Reporting', 'Tax Planning', 'Accounts Payable', 'Bank Reconciliation', 'Financial Modelling', 'Cost Accounting', 'MIS Reporting'],
  'financial analyst': ['Financial Modelling', 'Valuation', 'Advanced Excel', 'Power BI', 'SQL', 'DCF Analysis', 'Financial Reporting', 'Python', 'Tableau', 'Bloomberg'],
  'finance manager': ['P&L Management', 'Budgeting', 'Forecasting', 'Financial Reporting', 'Cash Flow Management', 'ERP Systems', 'Financial Modelling', 'Team Leadership', 'Stakeholder Management', 'Variance Analysis'],
  'hr manager': ['Talent Acquisition', 'Performance Management', 'HR Analytics', 'Employee Relations', 'HRIS', 'Payroll Management', 'L&D', 'Compensation & Benefits', 'Labour Law', 'Succession Planning'],
  'hr executive': ['Recruitment', 'Onboarding', 'Payroll', 'HR Policies', 'Employee Engagement', 'HRIS', 'Background Verification', 'Exit Management', 'MIS Reporting', 'Labour Compliance'],
  recruiter: ['Boolean Sourcing', 'Talent Mapping', 'ATS', 'Offer Negotiation', 'LinkedIn Recruiter', 'JD Writing', 'Interview Coordination', 'Employer Branding', 'Pipeline Management', 'Stakeholder Management'],
  'software engineer': ['React', 'Node.js', 'TypeScript', 'SQL', 'AWS', 'Docker', 'System Design', 'Git', 'REST APIs', 'Testing'],
  'full stack developer': ['React', 'Node.js', 'TypeScript', 'PostgreSQL', 'AWS', 'Docker', 'Redis', 'GraphQL', 'CI/CD', 'System Design'],
  'data analyst': ['SQL', 'Python', 'Tableau', 'Power BI', 'Excel', 'Data Visualization', 'Statistics', 'ETL', 'Google Analytics', 'Looker'],
  'data scientist': ['Python', 'Machine Learning', 'SQL', 'TensorFlow', 'Feature Engineering', 'Statistics', 'Spark', 'MLflow', 'Deep Learning', 'Data Visualization'],
  'product manager': ['Roadmapping', 'User Research', 'Agile', 'Stakeholder Management', 'SQL', 'Figma', 'A/B Testing', 'PRD Writing', 'OKRs', 'Analytics'],
  'devops engineer': ['Kubernetes', 'Docker', 'AWS', 'Terraform', 'CI/CD', 'Linux', 'Monitoring', 'Ansible', 'Shell Scripting', 'Prometheus'],
  'marketing manager': ['Digital Marketing', 'SEO', 'Google Analytics', 'Campaign Management', 'Content Strategy', 'Social Media', 'Email Marketing', 'CRM', 'Budget Management', 'A/B Testing'],
  'digital marketer': ['SEO/SEM', 'Google Ads', 'Meta Ads', 'Google Analytics 4', 'Email Marketing', 'Content Creation', 'Social Media Management', 'Conversion Rate Optimization', 'Copywriting', 'Marketing Automation'],
  'operations manager': ['Process Improvement', 'Project Management', 'Team Leadership', 'Supply Chain', 'KPI Management', 'ERP Systems', 'Budget Management', 'Vendor Management', 'Cross-functional Coordination', 'Lean/Six Sigma'],
  'business analyst': ['Requirement Gathering', 'Process Mapping', 'SQL', 'Excel', 'Stakeholder Management', 'Agile', 'BPMN', 'Power BI', 'User Stories', 'Gap Analysis'],
  'sales manager': ['B2B Sales', 'CRM', 'Pipeline Management', 'Team Leadership', 'Negotiation', 'Salesforce', 'Account Management', 'Revenue Forecasting', 'Cold Outreach', 'Customer Success'],
  default: ['Communication', 'Microsoft Office', 'Project Management', 'Problem Solving', 'Data Analysis', 'Leadership', 'Time Management', 'Teamwork', 'Critical Thinking', 'Presentation Skills'],
};

function normalizeSkill(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[_\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyRole(role) {
  if (!role) return 'default';

  const normalized = role.toLowerCase().trim();

  for (const key of Object.keys(ROLE_BENCHMARKS)) {
    if (
      normalized === key ||
      normalized.includes(key) ||
      key.includes(normalized)
    ) {
      return key;
    }
  }

  if (/account|ca\b|chartered|cpa/.test(normalized)) return 'accountant';
  if (/financial analyst/.test(normalized)) return 'financial analyst';
  if (/finance manag|cfo/.test(normalized)) return 'finance manager';
  if (/hr manag|people.*manag/.test(normalized)) return 'hr manager';
  if (/hr exec|hr officer/.test(normalized)) return 'hr executive';
  if (/recruit|talent acqui/.test(normalized)) return 'recruiter';
  if (/software eng|sde|developer|programmer/.test(normalized)) return 'software engineer';
  if (/full.?stack/.test(normalized)) return 'full stack developer';
  if (/data analys/.test(normalized)) return 'data analyst';
  if (/data scien|ml engineer/.test(normalized)) return 'data scientist';
  if (/product manag|pm\b/.test(normalized)) return 'product manager';
  if (/devops|sre|platform eng/.test(normalized)) return 'devops engineer';
  if (/market.*manag/.test(normalized)) return 'marketing manager';
  if (/digital market/.test(normalized)) return 'digital marketer';
  if (/ops manag|operations manag/.test(normalized)) return 'operations manager';
  if (/business analys|ba\b/.test(normalized)) return 'business analyst';
  if (/sales manag/.test(normalized)) return 'sales manager';

  return 'default';
}

function normalizeSkillArray(skills) {
  return (skills ?? [])
    .map((item) =>
      typeof item === 'string'
        ? item
        : typeof item?.name === 'string'
          ? item.name
          : ''
    )
    .filter(Boolean);
}

async function loadUserProfile(userId) {
  try {
    const { data: chiData } = await supabase
      .from('career_health_index')
      .select('top_skills,detected_profession,current_job_title')
      .eq('user_id', userId)
      .order('generated_at', { ascending: false })
      .limit(1);

    if (chiData?.length) {
      const chi = chiData[0];
      const skills = normalizeSkillArray(chi.top_skills);
      const role =
        chi.detected_profession ?? chi.current_job_title ?? null;

      if (skills.length || role) {
        return { userSkills: skills, targetRole: role };
      }
    }

    const { data: profileData } = await supabase
      .from('user_profiles')
      .select('skills,target_role,current_job_title')
      .eq('user_id', userId)
      .maybeSingle();

    if (profileData) {
      const skills = normalizeSkillArray(profileData.skills);
      const role =
        profileData.target_role ??
        profileData.current_job_title ??
        null;

      if (skills.length || role) {
        return { userSkills: skills, targetRole: role };
      }
    }

    const { data: userData } = await supabase
      .from('users')
      .select('skills,target_role,current_job_title')
      .eq('id', userId)
      .maybeSingle();

    if (userData) {
      return {
        userSkills: normalizeSkillArray(userData.skills),
        targetRole: userData.target_role ?? userData.current_job_title ?? null,
      };
    }

    return { userSkills: [], targetRole: null };
  } catch (error) {
    logger.warn('[SkillRecs] loadUserProfile failed', {
      userId,
      error: error.message,
    });

    return { userSkills: [], targetRole: null };
  }
}

async function loadBenchmarkSkills(role) {
  try {
    const { roleSkills } = await loadDatasets();
    const live = lookupRoleSkills(roleSkills, role);

    if (live?.length >= MIN_LIVE_BENCHMARK_COUNT) {
      return live;
    }
  } catch (error) {
    logger.warn('[SkillRecs] dataset fallback', {
      role,
      error: error.message,
    });
  }

  return ROLE_BENCHMARKS[classifyRole(role)] ?? ROLE_BENCHMARKS.default;
}

async function loadDemandScores(skillNames) {
  const scores = new Map();

  try {
    const { skillDemand } = await loadDatasets();

    for (const skill of skillNames) {
      const demand = lookupSkillDemand(skillDemand, skill);
      scores.set(skill, demand?.demand_score ?? DEFAULT_DEMAND_SCORE);
    }
  } catch {
    for (const skill of skillNames) {
      scores.set(skill, DEFAULT_DEMAND_SCORE);
    }
  }

  return scores;
}

async function getSkillRecommendations(userId) {
  const { userSkills, targetRole } = await loadUserProfile(userId);

  logger.info('[SkillRecs] profile loaded', {
    userId,
    skillCount: userSkills.length,
    targetRole,
  });

  if (!targetRole) {
    return {
      missingSkills: [],
      recommendedSkills: [],
      matchScore: 0,
      matchScoreImpact: 0,
      targetRole: null,
      hasTargetRole: false,
      explanation:
        'Set your target role in your profile to get personalised skill recommendations.',
      userSkillCount: userSkills.length,
      benchmarkSkills: [],
    };
  }

  const benchmarkSkills = await loadBenchmarkSkills(targetRole);
  const normalizedUserSkills = new Set(userSkills.map(normalizeSkill));

  const missingSkills = benchmarkSkills.filter(
    (skill) => !normalizedUserSkills.has(normalizeSkill(skill))
  );

  const demandScores = await loadDemandScores(missingSkills);

  const perSkillImpact = benchmarkSkills.length
    ? Math.round(100 / benchmarkSkills.length)
    : 5;

  const recommendedSkills = missingSkills
    .map((name) => ({
      name,
      demandScore: demandScores.get(name) ?? DEFAULT_DEMAND_SCORE,
      matchScoreImpact: perSkillImpact,
    }))
    .sort((a, b) => b.demandScore - a.demandScore)
    .slice(0, MAX_RECOMMENDATIONS);

  const matchedCount = benchmarkSkills.length - missingSkills.length;
  const matchScore = benchmarkSkills.length
    ? Math.round((matchedCount / benchmarkSkills.length) * 100)
    : 0;

  const gain = Math.min(
    recommendedSkills.length * perSkillImpact,
    100 - matchScore
  );

  let explanation;
  if (!recommendedSkills.length) {
    explanation = `Great — your profile already covers all key skills for ${targetRole}!`;
  } else if (recommendedSkills.length === 1) {
    explanation = `Adding "${recommendedSkills[0].name}" is the single highest-impact move for a ${targetRole} role.`;
  } else {
    explanation = `Start with these ${recommendedSkills.length} skills — they appear in most ${targetRole} job listings and will have the biggest impact on your score.`;
  }

  return {
    missingSkills: recommendedSkills.map((item) => item.name),
    recommendedSkills,
    matchScore,
    matchScoreImpact: gain,
    targetRole,
    hasTargetRole: true,
    explanation,
    userSkillCount: userSkills.length,
    benchmarkSkills,
  };
}

async function addSkillsToProfile(userId, skillNames) {
  const cleanedSkills = skillNames
    .map((value) => String(value).trim())
    .filter(Boolean);

  if (!cleanedSkills.length) {
    return { added: 0, skills: [] };
  }

  try {
    // Single transactional RPC — atomically merges into both
    // users.skills and user_profiles.skills with dedup
    const { data, error } = await supabase.rpc('add_skills_to_profile', {
      p_user_id: userId,
      p_skills:  cleanedSkills,
    });

    if (error) throw error;

    logger.info('[SkillRecs] skills added', {
      userId,
      added: data.added,
    });

    return {
      added:  data.added,
      skills: data.skills,
    };
  } catch (error) {
    logger.error('[SkillRecs] addSkillsToProfile failed', {
      userId,
      error: error.message,
    });

    throw error;
  }
}

module.exports = {
  getSkillRecommendations,
  addSkillsToProfile,
};