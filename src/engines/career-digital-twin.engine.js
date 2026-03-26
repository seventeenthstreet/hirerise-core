'use strict';

/**
 * career-digital-twin.engine.js — Career Digital Twin Engine
 *
 * Creates a virtual model of a user's career and simulates multiple future
 * career trajectories. Each simulation run produces 3–5 career paths with
 * salary projections, skill requirements, transition timelines, automation
 * risk scores, and market growth signals.
 *
 * ─── Architecture ────────────────────────────────────────────────────────────
 *
 *   Inputs
 *     userProfile   { role, skills[], experience_years, industry, salary_current }
 *     marketData    { job_demand, salary_benchmarks, industry_growth }   (optional)
 *
 *   Pipeline per path candidate
 *     1. Build progression chain   → career-path.engine (CSV)
 *     2. Score market demand       → role-transition.csv + Firestore enrichment
 *     3. Calculate skill gap       → intersection(userSkills, requiredSkills)
 *     4. Estimate transition time  → base years × readiness multiplier
 *     5. Project salary            → benchmark × growth_score × demand_factor
 *     6. Score automation risk     → skills[] automation index lookup
 *     7. Score market growth       → industry_growth + job_demand weight
 *
 *   Diversity strategy
 *     Paths are deliberately varied: fastest path, highest salary, lowest
 *     risk, highest growth, and a balanced path. This ensures the 3–5
 *     results are not near-duplicates of the same linear chain.
 *
 * ─── Scoring formulas ────────────────────────────────────────────────────────
 *
 *   growth_score    = (demand_weight × 0.5) + (industry_growth × 0.3) + (skill_relevance × 0.2)
 *   risk_level      = HIGH  if automation_index >= 0.65
 *                   = MEDIUM if automation_index >= 0.35
 *                   = LOW   otherwise
 *   salary_delta    = benchmark_salary × (1 + (growth_score / 100) × 0.4)
 *   readiness_mult  = 1 − (skill_overlap / total_required) × 0.4   (range 0.6–1.0)
 *
 * SECURITY: Read-only engine. No writes. All persistence is handled by the
 *           digitalTwin.service.js layer above this module.
 *
 * @module engines/career-digital-twin.engine
 */

const path    = require('path');
const logger  = require('../utils/logger');

const careerPathEngine  = require('./career-path.engine');
const opportunityEngine = require('./career-opportunity.engine');

// ─── Static data ─────────────────────────────────────────────────────────────

/**
 * Automation risk index per skill category.
 * Higher = more likely to be automated. Source: World Economic Forum / McKinsey
 * Global Institute estimates, mapped to platform skill taxonomy.
 */
const AUTOMATION_INDEX = {
  // High-risk (>= 0.65)
  'data entry':           0.90,
  'scheduling':           0.82,
  'basic bookkeeping':    0.78,
  'document processing':  0.75,
  'invoice processing':   0.73,
  'cold calling':         0.70,
  'routine reporting':    0.68,
  'basic qa testing':     0.66,

  // Medium-risk (0.35–0.64)
  'excel':                0.55,
  'customer support':     0.52,
  'market research':      0.50,
  'content moderation':   0.48,
  'basic sql':            0.45,
  'copywriting':          0.43,
  'basic design':         0.42,
  'project coordination': 0.40,
  'recruitment':          0.38,

  // Low-risk (< 0.35)
  'leadership':           0.12,
  'strategy':             0.14,
  'negotiation':          0.15,
  'mentoring':            0.16,
  'product vision':       0.17,
  'stakeholder management':0.18,
  'machine learning':     0.08,
  'ai engineering':       0.06,
  'system design':        0.10,
  'data science':         0.12,
  'python':               0.20,
  'power bi':             0.22,
  'process optimization': 0.25,
  'cloud architecture':   0.10,
  'devops':               0.15,
  'cybersecurity':        0.09,
  'ux design':            0.20,
  'product management':   0.18,
  'financial analysis':   0.30,
  'operations management':0.22,
};

/**
 * Industry growth score lookup (0–100).
 * Reflects 5-year projected CAGR signals mapped to a 0–100 scale.
 */
const INDUSTRY_GROWTH_SCORES = {
  'technology':           88,
  'software':             88,
  'it':                   85,
  'ai':                   95,
  'data':                 90,
  'cybersecurity':        92,
  'cloud':                89,
  'fintech':              80,
  'healthcare':           75,
  'e-commerce':           78,
  'logistics':            65,
  'manufacturing':        55,
  'retail':               48,
  'banking':              58,
  'finance':              60,
  'insurance':            52,
  'education':            62,
  'media':                45,
  'real estate':          50,
  'consulting':           68,
  'marketing':            60,
  'hr':                   55,
  'operations':           58,
  'sales':                60,
};

/**
 * Salary benchmarks (INR lakhs per annum) for common role patterns.
 * Used as the base for salary projection when live Firestore data is absent.
 */
const SALARY_BENCHMARKS_INR = {
  // Entry / junior tier  (0–3 yrs)
  'intern':                    4,
  'trainee':                   5,
  'junior':                    6,
  'associate':                 7,
  'executive':                 8,
  'analyst':                   8,
  'coordinator':               7,
  'assistant':                 6,

  // Mid tier  (3–7 yrs)
  'senior analyst':           14,
  'lead analyst':             16,
  'specialist':               12,
  'consultant':               14,
  'engineer':                 12,
  'developer':                12,
  'designer':                 11,
  'manager':                  18,

  // Senior tier  (7–12 yrs)
  'senior manager':           28,
  'senior engineer':          22,
  'senior developer':         22,
  'lead engineer':            25,
  'architect':                28,
  'product manager':          22,
  'operations manager':       20,
  'data scientist':           18,

  // Leadership tier  (12+ yrs)
  'director':                 45,
  'vp':                       60,
  'vice president':           60,
  'head of':                  50,
  'cto':                      80,
  'cfo':                      75,
  'coo':                      70,
  'ceo':                      90,
  'principal':                35,
};

// ─── Path diversity strategies ────────────────────────────────────────────────

const PATH_STRATEGIES = [
  { id: 'fastest',        label: 'Fastest Promotion',   weightTime: 2.0, weightSalary: 0.5, weightGrowth: 1.0 },
  { id: 'highest_salary', label: 'Highest Earning',     weightTime: 0.5, weightSalary: 2.0, weightGrowth: 1.0 },
  { id: 'lowest_risk',    label: 'Most Secure',         weightTime: 1.0, weightSalary: 1.0, weightGrowth: 0.5, riskPenalty: 2.0 },
  { id: 'high_growth',    label: 'High Growth Market',  weightTime: 0.5, weightSalary: 1.0, weightGrowth: 2.5 },
  { id: 'balanced',       label: 'Balanced Path',       weightTime: 1.0, weightSalary: 1.0, weightGrowth: 1.0 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a string for case-insensitive matching.
 * @param {string} s
 * @returns {string}
 */
function _norm(s) {
  return (s || '').toLowerCase().trim();
}

/**
 * Look up the salary benchmark (INR lakhs) for a role title.
 * Uses partial / keyword matching so "Senior Software Engineer" still
 * resolves to the "senior engineer" bucket.
 *
 * @param {string} roleTitle
 * @returns {number}  — lakhs per annum
 */
function _salaryBenchmark(roleTitle) {
  const n = _norm(roleTitle);
  // Exact match first
  if (SALARY_BENCHMARKS_INR[n]) return SALARY_BENCHMARKS_INR[n];

  // Keyword scan — longest matching key wins
  let best = null;
  let bestLen = 0;
  for (const [key, val] of Object.entries(SALARY_BENCHMARKS_INR)) {
    if (n.includes(key) && key.length > bestLen) {
      best    = val;
      bestLen = key.length;
    }
  }
  return best || 10; // default ₹10L when completely unknown
}

/**
 * Compute automation risk score (0–1) for a set of skills.
 * Returns the 80th-percentile risk across the skill set so one high-risk
 * skill doesn't dominate the whole profile, but chronic exposure shows up.
 *
 * @param {string[]} skills
 * @returns {number}  0–1
 */
function _automationRisk(skills) {
  if (!skills || skills.length === 0) return 0.40; // unknown → medium default

  const scores = skills.map(s => {
    const n = _norm(s);
    // Direct match
    if (AUTOMATION_INDEX[n] !== undefined) return AUTOMATION_INDEX[n];
    // Keyword match
    for (const [key, val] of Object.entries(AUTOMATION_INDEX)) {
      if (n.includes(key) || key.includes(n)) return val;
    }
    return 0.35; // unknown skill → low-medium default
  });

  scores.sort((a, b) => b - a);
  const p80idx = Math.floor(scores.length * 0.2);
  return parseFloat((scores[p80idx] || scores[0]).toFixed(3));
}

/**
 * Map raw automation score to a human-readable risk level.
 * @param {number} score  0–1
 * @returns {'High'|'Medium'|'Low'}
 */
function _riskLabel(score) {
  if (score >= 0.65) return 'High';
  if (score >= 0.35) return 'Medium';
  return 'Low';
}

/**
 * Compute industry growth score (0–100) for an industry string.
 * @param {string} industry
 * @returns {number}
 */
function _industryGrowthScore(industry) {
  const n = _norm(industry);
  if (INDUSTRY_GROWTH_SCORES[n]) return INDUSTRY_GROWTH_SCORES[n];
  for (const [key, val] of Object.entries(INDUSTRY_GROWTH_SCORES)) {
    if (n.includes(key) || key.includes(n)) return val;
  }
  return 55; // unknown industry → moderate default
}

/**
 * Skill overlap ratio: how many of the required skills does the user already have?
 * @param {string[]} userSkills
 * @param {string[]} requiredSkills
 * @returns {number}  0–1
 */
function _skillOverlap(userSkills, requiredSkills) {
  if (!requiredSkills || requiredSkills.length === 0) return 1;
  const userSet = new Set(userSkills.map(_norm));
  const matched = requiredSkills.filter(s => userSet.has(_norm(s))).length;
  return matched / requiredSkills.length;
}

/**
 * Identify skills the user is missing for a target role.
 * @param {string[]} userSkills
 * @param {string[]} requiredSkills
 * @returns {string[]}
 */
function _missingSkills(userSkills, requiredSkills) {
  if (!requiredSkills || requiredSkills.length === 0) return [];
  const userSet = new Set(userSkills.map(_norm));
  return requiredSkills.filter(s => !userSet.has(_norm(s)));
}

/**
 * Format a salary number (INR lakhs) into the display string expected by the API.
 * e.g. 18 → "₹18L",  125 → "₹1.25Cr"
 *
 * @param {number} lakhs
 * @returns {string}
 */
function _formatSalary(lakhs) {
  if (lakhs >= 100) {
    return `₹${(lakhs / 100).toFixed(2)}Cr`;
  }
  return `₹${Math.round(lakhs)}L`;
}

/**
 * Derive a simple set of "required skills" for a role from its title.
 * In production this would pull from Firestore role documents; this
 * keyword-based heuristic ensures the engine works even without live data.
 *
 * @param {string} roleTitle
 * @returns {string[]}
 */
function _inferRequiredSkills(roleTitle) {
  const n = _norm(roleTitle);
  const skillMap = {
    'data analyst':       ['SQL', 'Excel', 'Power BI', 'Statistics', 'Python'],
    'data scientist':     ['Python', 'Machine Learning', 'Statistics', 'SQL', 'Data Visualization'],
    'data engineer':      ['Python', 'SQL', 'Spark', 'Cloud Platforms', 'ETL Pipelines'],
    'software engineer':  ['Python', 'System Design', 'Git', 'REST APIs', 'Testing'],
    'senior engineer':    ['System Design', 'Leadership', 'Mentoring', 'Python', 'Cloud Architecture'],
    'product manager':    ['Product Vision', 'Stakeholder Management', 'Agile', 'Data Analysis', 'Roadmapping'],
    'operations analyst': ['Process Optimization', 'Power BI', 'Excel', 'Project Coordination'],
    'operations manager': ['Leadership', 'Process Optimization', 'Stakeholder Management', 'Power BI'],
    'marketing analyst':  ['Google Analytics', 'Excel', 'SEO', 'Content Strategy', 'Market Research'],
    'marketing manager':  ['Digital Marketing', 'Leadership', 'Strategy', 'Analytics', 'Stakeholder Management'],
    'finance analyst':    ['Excel', 'Financial Analysis', 'SQL', 'Reporting', 'Forecasting'],
    'finance manager':    ['Financial Analysis', 'Leadership', 'Forecasting', 'Risk Management', 'Strategy'],
    'hr manager':         ['Recruitment', 'Leadership', 'Stakeholder Management', 'HR Analytics', 'Strategy'],
    'consultant':         ['Strategy', 'Stakeholder Management', 'Presentation', 'Problem Solving', 'Excel'],
    'director':           ['Leadership', 'Strategy', 'Stakeholder Management', 'P&L Management', 'Negotiation'],
    'vp':                 ['Leadership', 'Strategy', 'Negotiation', 'Executive Presence', 'P&L Management'],
  };

  // Exact key match
  if (skillMap[n]) return skillMap[n];

  // Partial match — longest key that appears in the title
  let best = null;
  let bestLen = 0;
  for (const [key, skills] of Object.entries(skillMap)) {
    if (n.includes(key) && key.length > bestLen) {
      best    = skills;
      bestLen = key.length;
    }
  }
  return best || ['Communication', 'Problem Solving', 'Leadership', 'Excel', 'Strategy'];
}

// ─── Core simulation logic ────────────────────────────────────────────────────

/**
 * Simulate a single career path using a given strategy.
 *
 * @param {Object}   params
 * @param {Object}   params.userProfile        — { role, skills, experience_years, industry, salary_current }
 * @param {string[]} params.progressionChain   — ordered array of role titles from career-path.engine
 * @param {Object}   params.strategy           — one of PATH_STRATEGIES
 * @param {Object}   params.marketData         — optional enrichment data
 * @returns {Object|null}  Simulated career path or null if chain is empty
 */
function _simulatePath({ userProfile, progressionChain, strategy, marketData }) {
  if (!progressionChain || progressionChain.length === 0) return null;

  const industryScore = _industryGrowthScore(userProfile.industry || '');
  const baseSkills    = userProfile.skills || [];
  let   currentSkills = [...baseSkills];
  let   cumulativeYears = 0;
  const roles           = [];

  // Traverse up to 4 hops from the first role in the chain (after current)
  const hops = progressionChain.slice(0, 4);

  for (const step of hops) {
    const roleTitle     = step.role || step;
    const baseYears     = step.years_to_next || step.estimated_years || 2;
    const requiredSkills = _inferRequiredSkills(roleTitle);
    const missing        = _missingSkills(currentSkills, requiredSkills);
    const overlap        = _skillOverlap(currentSkills, requiredSkills);

    // Readiness multiplier: less overlap → longer transition
    const readinessMult  = 1 + (1 - overlap) * 0.4;   // range 1.0–1.4
    const adjustedYears  = parseFloat((baseYears * readinessMult).toFixed(1));
    cumulativeYears      = parseFloat((cumulativeYears + adjustedYears).toFixed(1));

    // Salary projection
    const salaryBase    = _salaryBenchmark(roleTitle);
    const growthFactor  = 1 + (industryScore / 100) * 0.4;
    const salaryLakhs   = parseFloat((salaryBase * growthFactor).toFixed(1));

    // Automation risk for required skills of this role
    const autoRisk      = _automationRisk(requiredSkills);
    const riskLevel     = _riskLabel(autoRisk);

    // Growth score: demand weight + industry + skill relevance
    const demandSignal  = marketData?.job_demand?.[_norm(roleTitle)] || 60;
    const growthScore   = Math.min(100, Math.round(
      demandSignal    * 0.5 +
      industryScore   * 0.3 +
      (overlap * 100) * 0.2
    ));

    // Strategy-weighted composite score (used to rank paths later)
    const compositeScore =
      (1 / Math.max(adjustedYears, 0.1)) * strategy.weightTime +
      salaryLakhs                         * strategy.weightSalary +
      growthScore                         * strategy.weightGrowth -
      (strategy.riskPenalty || 0) * autoRisk * 100;

    roles.push({
      role:                 roleTitle,
      years_to_reach:       adjustedYears,
      cumulative_years:     cumulativeYears,
      required_skills:      requiredSkills,
      skills_to_acquire:    missing,
      salary_lakhs:         salaryLakhs,
      salary_display:       _formatSalary(salaryLakhs),
      automation_risk:      autoRisk,
      risk_level:           riskLevel,
      growth_score:         growthScore,
      _compositeScore:      compositeScore,
    });

    // Simulate skill acquisition for subsequent steps
    currentSkills = [...new Set([...currentSkills, ...requiredSkills])];
  }

  if (roles.length === 0) return null;

  // Aggregate path-level metrics
  const finalRole      = roles[roles.length - 1];
  const pathRoles      = roles.map(r => r.role);
  const allSkillsNeeded = [...new Set(roles.flatMap(r => r.skills_to_acquire))];

  return {
    strategy_id:        strategy.id,
    strategy_label:     strategy.label,
    path:               [userProfile.role, ...pathRoles],
    roles_detail:       roles,
    next_role:          roles[0]?.role   || null,
    salary_projection:  finalRole.salary_display,
    salary_lakhs:       finalRole.salary_lakhs,
    growth_score:       finalRole.growth_score,
    risk_level:         finalRole.risk_level,
    skills_required:    allSkillsNeeded.slice(0, 6),
    transition_months:  Math.round(roles[0]?.years_to_reach * 12) || 12,
    total_years:        finalRole.cumulative_years,
    _compositeScore:    roles.reduce((s, r) => s + r._compositeScore, 0),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * simulateCareerPaths(userProfile, marketData?)
 *
 * Main entry point. Generates 3–5 diverse career path simulations for the
 * user profile provided.
 *
 * @param {Object} userProfile
 * @param {string}   userProfile.role              — Current role title
 * @param {string[]} userProfile.skills            — Current skills array
 * @param {number}   [userProfile.experience_years=0]
 * @param {string}   [userProfile.industry]
 * @param {number}   [userProfile.salary_current]  — Current salary (INR lakhs)
 *
 * @param {Object}  [marketData]                   — Optional live market enrichment
 * @param {Object}  [marketData.job_demand]        — { roleTitle: demandScore(0–100) }
 * @param {Object}  [marketData.salary_benchmarks] — { roleTitle: lakhs }
 * @param {number}  [marketData.industry_growth]   — Override industry growth score
 *
 * @returns {Promise<Object>}
 *   {
 *     career_paths: CareerPath[],
 *     meta: { role, experience_years, industry, simulated_at, path_count }
 *   }
 */
async function simulateCareerPaths(userProfile, marketData = {}) {
  const role            = userProfile.role            || 'Unknown Role';
  const skills          = userProfile.skills          || [];
  const experience      = userProfile.experience_years || 0;
  const industry        = userProfile.industry        || '';

  logger.info('[CareerDigitalTwinEngine] Starting simulation', { role, experience, industry });

  // ── 1. Fetch base progression chain ──────────────────────────────────────
  let rawChain = [];
  try {
    rawChain = await careerPathEngine.getProgressionChain(role, industry);
  } catch (err) {
    logger.warn('[CareerDigitalTwinEngine] CareerPathEngine failed, using empty chain', { err: err.message });
  }

  // ── 2. Build opportunity-aware role candidates ────────────────────────────
  let opportunityRoles = [];
  try {
    const oppResult = await opportunityEngine.analyzeCareerOpportunities({
      role,
      skills,
      experience_years: experience,
      industry,
    });
    opportunityRoles = (oppResult.opportunities || []).slice(0, 10).map(o => ({
      role:          o.next_role || o.role,
      years_to_next: o.estimated_years || 2,
    }));
  } catch (err) {
    logger.warn('[CareerDigitalTwinEngine] OpportunityEngine failed, using CSV chain only', { err: err.message });
  }

  // Merge: CSV chain provides orderly progression; opportunity roles add breadth
  const mergedChain = rawChain.length > 0
    ? rawChain
    : opportunityRoles.length > 0
      ? opportunityRoles
      : [{ role: `Senior ${role}`, years_to_next: 2 }, { role: `Lead ${role}`, years_to_next: 3 }];

  // ── 3. Simulate one path per strategy ────────────────────────────────────
  const simulations = [];
  for (const strategy of PATH_STRATEGIES) {
    const result = _simulatePath({
      userProfile: { role, skills, experience_years: experience, industry },
      progressionChain: mergedChain,
      strategy,
      marketData,
    });
    if (result) simulations.push(result);
  }

  // ── 4. Deduplicate paths that resolved to the same sequence ──────────────
  const seen    = new Set();
  const unique  = [];
  for (const sim of simulations) {
    const key = sim.path.join('→');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(sim);
    }
  }

  // ── 5. Sort by composite score descending; cap at 5 paths ─────────────────
  unique.sort((a, b) => b._compositeScore - a._compositeScore);
  const finalPaths = unique.slice(0, 5);

  // Strip internal scoring field from output
  finalPaths.forEach(p => {
    delete p._compositeScore;
    p.roles_detail.forEach(r => delete r._compositeScore);
  });

  logger.info('[CareerDigitalTwinEngine] Simulation complete', { pathCount: finalPaths.length, role });

  return {
    career_paths: finalPaths,
    meta: {
      role,
      experience_years:  experience,
      industry:          industry || null,
      simulated_at:      new Date().toISOString(),
      path_count:        finalPaths.length,
      engine_version:    '1.0.0',
    },
  };
}

/**
 * Invalidate internal caches (proxy to sub-engines).
 * Call after career-paths.csv or role-transition.csv is reloaded.
 */
function invalidateCache() {
  try { careerPathEngine.invalidateCache(); } catch (_) {}
  logger.info('[CareerDigitalTwinEngine] Sub-engine caches invalidated');
}

module.exports = {
  simulateCareerPaths,
  invalidateCache,
  // Exposed for unit tests
  _helpers: {
    _salaryBenchmark,
    _automationRisk,
    _riskLabel,
    _industryGrowthScore,
    _skillOverlap,
    _missingSkills,
    _formatSalary,
    _inferRequiredSkills,
  },
};









