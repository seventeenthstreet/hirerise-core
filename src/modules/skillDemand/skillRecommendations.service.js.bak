'use strict';

/**
 * skillRecommendations.service.js
 * Located: src/modules/skillDemand/
 *
 * Paths from here:
 *   ../../utils/logger         = src/utils/logger
 *   ../../config/supabase      = src/config/supabase
 *   ./repository/...           = src/modules/skillDemand/repository/...
 *   ../../core/supabase  = src/core/supabase
 */

const logger = require('../../utils/logger');

// ─── Role → benchmark skills (static fallback) ────────────────────────────────

const ROLE_BENCHMARKS = {
  accountant:               ['Advanced Excel', 'Tally ERP', 'GST Compliance', 'Financial Reporting', 'Tax Planning', 'Accounts Payable', 'Bank Reconciliation', 'Financial Modelling', 'Cost Accounting', 'MIS Reporting'],
  'financial analyst':      ['Financial Modelling', 'Valuation', 'Advanced Excel', 'Power BI', 'SQL', 'DCF Analysis', 'Financial Reporting', 'Python', 'Tableau', 'Bloomberg'],
  'finance manager':        ['P&L Management', 'Budgeting', 'Forecasting', 'Financial Reporting', 'Cash Flow Management', 'ERP Systems', 'Financial Modelling', 'Team Leadership', 'Stakeholder Management', 'Variance Analysis'],
  'hr manager':             ['Talent Acquisition', 'Performance Management', 'HR Analytics', 'Employee Relations', 'HRIS', 'Payroll Management', 'L&D', 'Compensation & Benefits', 'Labour Law', 'Succession Planning'],
  'hr executive':           ['Recruitment', 'Onboarding', 'Payroll', 'HR Policies', 'Employee Engagement', 'HRIS', 'Background Verification', 'Exit Management', 'MIS Reporting', 'Labour Compliance'],
  recruiter:                ['Boolean Sourcing', 'Talent Mapping', 'ATS', 'Offer Negotiation', 'LinkedIn Recruiter', 'JD Writing', 'Interview Coordination', 'Employer Branding', 'Pipeline Management', 'Stakeholder Management'],
  'software engineer':      ['React', 'Node.js', 'TypeScript', 'SQL', 'AWS', 'Docker', 'System Design', 'Git', 'REST APIs', 'Testing'],
  'full stack developer':   ['React', 'Node.js', 'TypeScript', 'PostgreSQL', 'AWS', 'Docker', 'Redis', 'GraphQL', 'CI/CD', 'System Design'],
  'data analyst':           ['SQL', 'Python', 'Tableau', 'Power BI', 'Excel', 'Data Visualization', 'Statistics', 'ETL', 'Google Analytics', 'Looker'],
  'data scientist':         ['Python', 'Machine Learning', 'SQL', 'TensorFlow', 'Feature Engineering', 'Statistics', 'Spark', 'MLflow', 'Deep Learning', 'Data Visualization'],
  'product manager':        ['Roadmapping', 'User Research', 'Agile', 'Stakeholder Management', 'SQL', 'Figma', 'A/B Testing', 'PRD Writing', 'OKRs', 'Analytics'],
  'devops engineer':        ['Kubernetes', 'Docker', 'AWS', 'Terraform', 'CI/CD', 'Linux', 'Monitoring', 'Ansible', 'Shell Scripting', 'Prometheus'],
  'marketing manager':      ['Digital Marketing', 'SEO', 'Google Analytics', 'Campaign Management', 'Content Strategy', 'Social Media', 'Email Marketing', 'CRM', 'Budget Management', 'A/B Testing'],
  'digital marketer':       ['SEO/SEM', 'Google Ads', 'Meta Ads', 'Google Analytics 4', 'Email Marketing', 'Content Creation', 'Social Media Management', 'Conversion Rate Optimization', 'Copywriting', 'Marketing Automation'],
  'operations manager':     ['Process Improvement', 'Project Management', 'Team Leadership', 'Supply Chain', 'KPI Management', 'ERP Systems', 'Budget Management', 'Vendor Management', 'Cross-functional Coordination', 'Lean/Six Sigma'],
  'business analyst':       ['Requirement Gathering', 'Process Mapping', 'SQL', 'Excel', 'Stakeholder Management', 'Agile', 'BPMN', 'Power BI', 'User Stories', 'Gap Analysis'],
  'sales manager':          ['B2B Sales', 'CRM', 'Pipeline Management', 'Team Leadership', 'Negotiation', 'Salesforce', 'Account Management', 'Revenue Forecasting', 'Cold Outreach', 'Customer Success'],
  default:                  ['Communication', 'Microsoft Office', 'Project Management', 'Problem Solving', 'Data Analysis', 'Leadership', 'Time Management', 'Teamwork', 'Critical Thinking', 'Presentation Skills'],
};

function classifyRole(role) {
  if (!role) return 'default';
  const r = role.toLowerCase().trim();
  for (const key of Object.keys(ROLE_BENCHMARKS)) {
    if (r === key || r.includes(key) || key.includes(r)) return key;
  }
  if (/account|ca\b|chartered|cpa/.test(r))               return 'accountant';
  if (/financial analyst/.test(r))                          return 'financial analyst';
  if (/finance manag|cfo/.test(r))                          return 'finance manager';
  if (/hr manag|people.*manag/.test(r))                     return 'hr manager';
  if (/hr exec|hr officer/.test(r))                         return 'hr executive';
  if (/recruit|talent acqui/.test(r))                       return 'recruiter';
  if (/software eng|sde|developer|programmer/.test(r))      return 'software engineer';
  if (/full.?stack/.test(r))                                 return 'full stack developer';
  if (/data analys/.test(r))                                 return 'data analyst';
  if (/data scien|ml engineer/.test(r))                     return 'data scientist';
  if (/product manag|pm\b/.test(r))                         return 'product manager';
  if (/devops|sre|platform eng/.test(r))                    return 'devops engineer';
  if (/market.*manag/.test(r))                               return 'marketing manager';
  if (/digital market/.test(r))                              return 'digital marketer';
  if (/ops manag|operations manag/.test(r))                 return 'operations manager';
  if (/business analys|ba\b/.test(r))                       return 'business analyst';
  if (/sales manag/.test(r))                                 return 'sales manager';
  return 'default';
}

function normalizeSkill(s) {
  return (s || '').toLowerCase().replace(/\./g, '').replace(/[_\-/]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Load user profile ─────────────────────────────────────────────────────────

async function loadUserProfile(userId) {
  try {
    const { db } = require('../../config/supabase');

    // CHI snapshot first (most accurate)
    try {
      const chiSnap = await db
        .collection('careerHealthIndex')
        .where('userId', '==', userId)
        .orderBy('generatedAt', 'desc')
        .limit(1)
        .get();

      if (!chiSnap.empty) {
        const chi = chiSnap.docs[0].data();
        const skills    = chi.topSkills ?? chi.skills ?? [];
        const role      = chi.detectedProfession ?? chi.currentJobTitle ?? null;
        if (skills.length > 0 || role) {
          return {
            userSkills: skills.map(s => typeof s === 'string' ? s : s?.name ?? '').filter(Boolean),
            targetRole: role,
          };
        }
      }
    } catch (chiErr) {
      logger.warn('[SkillRecs] CHI query failed, trying userProfiles', { error: chiErr.message });
    }

    // Fallback: userProfiles
    try {
      const profileSnap = await db.collection('userProfiles').doc(userId).get();
      if (profileSnap.exists) {
        const p = profileSnap.data();
        const skills = (p.skills ?? []).map(s => typeof s === 'string' ? s : s?.name ?? '').filter(Boolean);
        const role   = p.targetRole ?? p.currentJobTitle ?? null;
        if (skills.length > 0 || role) return { userSkills: skills, targetRole: role };
      }
    } catch {}

    // Fallback: users doc
    const userSnap = await db.collection('users').doc(userId).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      return {
        userSkills: (u.skills ?? []).map(s => typeof s === 'string' ? s : s?.name ?? '').filter(Boolean),
        targetRole: u.targetRole ?? u.jobTitle ?? null,
      };
    }

    return { userSkills: [], targetRole: null };
  } catch (err) {
    logger.warn('[SkillRecs] loadUserProfile failed', { userId, error: err.message });
    return { userSkills: [], targetRole: null };
  }
}

// ─── Load benchmark skills ────────────────────────────────────────────────────

async function loadBenchmarkSkills(role) {
  try {
    const { loadDatasets, lookupRoleSkills } = require('./repository/skillDemandDataset');
    const { roleSkills } = await loadDatasets();
    const live = lookupRoleSkills(roleSkills, role);
    if (live && live.length >= 3) return live;
  } catch (err) {
    logger.warn('[SkillRecs] Supabase dataset failed, using static fallback', { error: err.message });
  }
  const key = classifyRole(role);
  return ROLE_BENCHMARKS[key] ?? ROLE_BENCHMARKS.default;
}

// ─── Load demand scores ───────────────────────────────────────────────────────

async function loadDemandScores(skillNames) {
  const scores = new Map();
  try {
    const { loadDatasets, lookupSkillDemand } = require('./repository/skillDemandDataset');
    const { skillDemand } = await loadDatasets();
    for (const skill of skillNames) {
      const d = lookupSkillDemand(skillDemand, skill);
      scores.set(skill, d?.demand_score ?? 60);
    }
  } catch {
    for (const skill of skillNames) scores.set(skill, 60);
  }
  return scores;
}

// ─── Main API ─────────────────────────────────────────────────────────────────

async function getSkillRecommendations(userId) {
  const { userSkills, targetRole } = await loadUserProfile(userId);

  logger.info('[SkillRecs] profile', { userId, skillCount: userSkills.length, targetRole });

  if (!targetRole) {
    return {
      missingSkills:     [],
      recommendedSkills: [],
      matchScore:        0,
      matchScoreImpact:  0,
      targetRole:        null,
      hasTargetRole:     false,
      explanation:       'Set your target role in your profile to get personalised skill recommendations.',
      userSkillCount:    userSkills.length,
      benchmarkSkills:   [],
    };
  }

  const benchmarkSkills = await loadBenchmarkSkills(targetRole);
  const normUser        = new Set(userSkills.map(normalizeSkill));
  const allMissing      = benchmarkSkills.filter(s => !normUser.has(normalizeSkill(s)));
  const demandScores    = await loadDemandScores(allMissing);

  const perSkillImpact  = benchmarkSkills.length > 0 ? Math.round(100 / benchmarkSkills.length) : 5;

  // Cap at 6 — never overwhelm the user with a huge list
  const MAX_RECS = 6;
  const recommendedSkills = allMissing
    .map(name => ({ name, demandScore: demandScores.get(name) ?? 60, matchScoreImpact: perSkillImpact }))
    .sort((a, b) => b.demandScore - a.demandScore)
    .slice(0, MAX_RECS);

  const matched    = benchmarkSkills.filter(s => normUser.has(normalizeSkill(s)));
  const matchScore = benchmarkSkills.length > 0 ? Math.round((matched.length / benchmarkSkills.length) * 100) : 0;
  const topCount   = recommendedSkills.length;
  const gain       = Math.min(topCount * perSkillImpact, 100 - matchScore);

  // Human-friendly copy — only when we have a real target role
  let explanation = null;
  if (targetRole) {
    if (topCount === 0) {
      explanation = `Great — your profile already covers all key skills for ${targetRole}!`;
    } else if (topCount === 1) {
      explanation = `Adding "${recommendedSkills[0].name}" is the single highest-impact move for a ${targetRole} role.`;
    } else {
      explanation = `Start with these ${topCount} skills — they appear in most ${targetRole} job listings and will have the biggest impact on your score.`;
    }
  }

  return {
    missingSkills:     recommendedSkills.map(s => s.name),
    recommendedSkills,
    matchScore,
    matchScoreImpact:  gain,
    targetRole,
    hasTargetRole:     true,
    explanation,
    userSkillCount:    userSkills.length,
    benchmarkSkills,
  };
}

async function addSkillsToProfile(userId, skillNames) {
  const { db } = require('../../config/supabase');
  const normalizedNew = skillNames.map(s => String(s).trim()).filter(Boolean);
  if (!normalizedNew.length) return { added: 0, skills: [] };

  try {
    const userSnap = await db.collection('users').doc(userId).get();
    const existing = new Set(
      (userSnap.exists ? userSnap.data()?.skills ?? [] : [])
        .map(s => (typeof s === 'string' ? s : s?.name ?? '').toLowerCase())
    );
    const toAdd = normalizedNew.filter(s => !existing.has(s.toLowerCase()));
    if (!toAdd.length) return { added: 0, skills: [] };

    const batch = db.batch();
    const now   = new Date();

    batch.set(db.collection('users').doc(userId), { skills: [...existing, ...toAdd.map(s => s.toLowerCase())], updatedAt: now }, { merge: true });
    batch.set(db.collection('userProfiles').doc(userId), {
      skills: [...toAdd.map(name => ({ name, proficiency: 'beginner', addedAt: now.toISOString() }))],
      updatedAt: now,
    }, { merge: true });

    await batch.commit();
    logger.info('[SkillRecs] added skills', { userId, count: toAdd.length });
    return { added: toAdd.length, skills: toAdd };
  } catch (err) {
    logger.error('[SkillRecs] addSkillsToProfile failed', { userId, error: err.message });
    throw err;
  }
}

module.exports = { getSkillRecommendations, addSkillsToProfile };









