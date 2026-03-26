'use strict';

/**
 * jobMatchingEngine.service.js — Job Matching Engine (Job Seeker Path)
 *
 * Matches a job seeker to relevant roles from the platform's role database
 * using a weighted scoring algorithm:
 *
 *   40% Skill match      — overlap of user skills vs role required skills
 *   30% Experience match — years comparison vs role level requirements
 *   20% Industry match   — user industry vs role sector alignment
 *   10% Role similarity  — semantic similarity of job titles
 *
 * Data sources (read-only):
 *   Firestore userProfiles/{uid}            — skills, targetRole, industry
 *   Firestore roles/{id}                    — role titles, families
 *   Firestore role_skills/{id}              — required skills per role
 *   Firestore salaryBands/{id}              — salary ranges
 *   CacheManager                            — Redis/Memory TTL 10 min
 *
 * @module modules/jobSeeker/jobMatchingEngine.service
 */

const { db }       = require('../../config/supabase');
const cacheManager = require('../../core/cache/cache.manager');
const logger       = require('../../utils/logger');

const CACHE_TTL_SECONDS = 600; // 10 minutes
const cache = cacheManager.getClient();

// ─── Scoring weights ──────────────────────────────────────────────────────────

const WEIGHTS = Object.freeze({
  skill:      0.40,
  experience: 0.30,
  industry:   0.20,
  role:       0.10,
});

// ─── Cache helper ─────────────────────────────────────────────────────────────

async function _cached(key, ttl, fn) {
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (_) { /* cache miss */ }

  const result = await fn();

  try {
    await cache.set(key, JSON.stringify(result), 'EX', ttl);
  } catch (_) { /* non-fatal */ }

  return result;
}

// ─── Profile loader ───────────────────────────────────────────────────────────

async function _loadUserProfile(userId) {
  // FIX: Read from ALL three collections — whichever was populated wins.
  // - userProfiles: populated by new resume.service.js after our fix
  // - users: populated by old resume.service.js (existing users before fix)
  // - onboardingProgress: fallback for users who went through onboarding
  const [profileSnap, progressSnap, userSnap] = await Promise.all([
    db.collection('userProfiles').doc(userId).get(),
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('users').doc(userId).get(),
  ]);

  const profile  = profileSnap.exists  ? profileSnap.data()  : {};
  const progress = progressSnap.exists ? progressSnap.data() : {};
  const user     = userSnap.exists     ? userSnap.data()     : {};

  // Pick the first non-empty skills array from: userProfiles → users → onboardingProgress
  const rawSkills =
    (Array.isArray(profile.skills)  && profile.skills.length  > 0) ? profile.skills  :
    (Array.isArray(user.skills)     && user.skills.length     > 0) ? user.skills     :
    (Array.isArray(progress.skills) && progress.skills.length > 0) ? progress.skills :
    [];

  const skills = rawSkills
    .map(s => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean)
    .map(s => s.toLowerCase());

  // Pick industry from whichever collection has it
  const industry = (
    profile.industry  ||
    user.industry     ||
    progress.industry ||
    ''
  ).toLowerCase();

  // Pick experience years from whichever collection has it
  const yearsExperience = parseFloat(
    profile.experienceYears  || profile.yearsExperience  ||
    user.experience          || user.experienceYears     ||
    progress.experienceYears ||
    0
  );

  // Pick target role from whichever collection has it
  const targetRole =
    profile.targetRole      || profile.currentJobTitle  ||
    user.currentJobTitle    ||
    progress.targetRole     ||
    null;

  return {
    skills,
    skillsOriginal: rawSkills.map(s => typeof s === 'string' ? s : s?.name).filter(Boolean),
    targetRole,
    industry,
    yearsExperience,
  };
}

// ─── Scoring functions ────────────────────────────────────────────────────────

/**
 * Skill score (0–100): percentage of role's required skills the user has.
 */
function _skillScore(userSkills, roleSkills) {
  if (!roleSkills || roleSkills.length === 0) return 50; // unknown — neutral
  const userSet = new Set(userSkills);
  const matches = roleSkills.filter(s => userSet.has(s.toLowerCase())).length;
  return Math.round((matches / roleSkills.length) * 100);
}

/**
 * Experience score (0–100): how well the user's years match the role's requirement.
 * Full score if user meets or exceeds requirement. Partial score for being close.
 */
function _experienceScore(userYears, requiredYears) {
  if (!requiredYears || requiredYears <= 0) return 75; // no requirement — good
  if (userYears >= requiredYears) return 100;
  // Partial credit — within 2 years = 70, within 4 years = 50, beyond = 25
  const gap = requiredYears - userYears;
  if (gap <= 1) return 85;
  if (gap <= 2) return 70;
  if (gap <= 4) return 50;
  return 25;
}

/**
 * Industry score (0–100): industry/sector alignment.
 */
function _industryScore(userIndustry, roleSector) {
  if (!userIndustry || !roleSector) return 50; // unknown — neutral
  const u = userIndustry.toLowerCase();
  const r = roleSector.toLowerCase();
  if (u === r) return 100;

  // Partial match for related sectors
  const RELATED = {
    'finance & banking': ['accounting', 'finance', 'banking', 'fintech', 'insurance'],
    'technology & software': ['it', 'software', 'tech', 'saas', 'data'],
    'healthcare': ['medical', 'pharma', 'health'],
    'manufacturing': ['production', 'operations', 'industrial'],
    'retail & e-commerce': ['retail', 'ecommerce', 'fmcg', 'consumer'],
    'consulting': ['advisory', 'professional services', 'management consulting'],
  };

  for (const [key, synonyms] of Object.entries(RELATED)) {
    if (u.includes(key) || synonyms.some(s => u.includes(s))) {
      if (r.includes(key) || synonyms.some(s => r.includes(s))) {
        return 75;
      }
    }
  }

  return 30; // different industry
}

/**
 * Role similarity score (0–100): title keyword overlap.
 */
function _roleSimilarityScore(userTitle, roleTitle) {
  if (!userTitle || !roleTitle) return 50;

  const tokenize = str => str.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);

  const uTokens = new Set(tokenize(userTitle));
  const rTokens = tokenize(roleTitle);

  if (rTokens.length === 0) return 50;
  const matches = rTokens.filter(t => uTokens.has(t)).length;
  return Math.round((matches / rTokens.length) * 100);
}

/**
 * Compute composite match score from component scores.
 */
function _compositeScore(skillScore, expScore, industryScore, roleScore) {
  return Math.round(
    WEIGHTS.skill      * skillScore   +
    WEIGHTS.experience * expScore     +
    WEIGHTS.industry   * industryScore +
    WEIGHTS.role       * roleScore
  );
}

// ─── Role fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch all active roles with their required skills.
 *
 * FIX: Three bugs caused all roles to score identically (53%):
 *   1. Collection name mismatch — seed writes 'roleSkills', engine queried 'role_skills'.
 *      Fixed by trying both collection names and merging results.
 *   2. Field name mismatch — seed stores skills as an array on the doc (skills[].name),
 *      engine queried sub-docs with role_id field. Fixed by reading skills[] directly.
 *   3. No finance/accounting roles in Firestore seed — engine only had tech roles, so
 *      an accountant CV always matched Data Analyst / DevOps etc.
 *      Fixed by BUILT_IN_ROLES fallback (mirrors resume parser's built-in role dictionary).
 *
 * Results are cached for 30 minutes (role data changes infrequently).
 */

// ─── Built-in role → skills dictionary ───────────────────────────────────────
// Used as a fallback when Firestore roles/role_skills collections are empty or
// missing required skills. Covers the most common Indian job market roles.
// Skills must be lowercase to match the normalised user skill set.
const BUILT_IN_ROLES = [
  // ── Finance & Accounting ──────────────────────────────────────────────────
  {
    id: 'accountant', title: 'Accountant', sector: 'Finance & Banking',
    experienceYears: 2,
    requiredSkills: ['tally', 'gst', 'tds', 'excel', 'accounts payable', 'accounts receivable',
                     'bank reconciliation', 'financial reporting', 'taxation', 'mis reporting',
                     'zoho books', 'quickbooks', 'budgeting', 'payroll', 'audit coordination'],
  },
  {
    id: 'senior-accountant', title: 'Senior Accountant', sector: 'Finance & Banking',
    experienceYears: 5,
    requiredSkills: ['tally', 'gst', 'tds', 'excel', 'financial reporting', 'taxation',
                     'compliance', 'budgeting', 'forecasting', 'mis reporting', 'payroll',
                     'audit coordination', 'accounts payable', 'accounts receivable'],
  },
  {
    id: 'financial-analyst', title: 'Financial Analyst', sector: 'Finance & Banking',
    experienceYears: 3,
    requiredSkills: ['excel', 'financial reporting', 'budgeting', 'forecasting', 'mis reporting',
                     'financial analysis', 'power bi', 'tableau', 'sql'],
  },
  {
    id: 'tax-consultant', title: 'Tax Consultant', sector: 'Finance & Banking',
    experienceYears: 3,
    requiredSkills: ['gst', 'tds', 'taxation', 'compliance', 'excel', 'tally', 'income tax'],
  },
  {
    id: 'finance-manager', title: 'Finance Manager', sector: 'Finance & Banking',
    experienceYears: 7,
    requiredSkills: ['financial reporting', 'budgeting', 'forecasting', 'compliance',
                     'mis reporting', 'excel', 'gst', 'tds', 'audit coordination', 'payroll'],
  },
  {
    id: 'auditor', title: 'Auditor', sector: 'Finance & Banking',
    experienceYears: 3,
    requiredSkills: ['audit coordination', 'compliance', 'financial reporting', 'excel',
                     'tally', 'gst', 'tds', 'bank reconciliation'],
  },
  // ── Software Engineering ──────────────────────────────────────────────────
  {
    id: 'software-engineer', title: 'Software Engineer', sector: 'Technology & Software',
    experienceYears: 2,
    requiredSkills: ['javascript', 'python', 'sql', 'git', 'rest api', 'node.js'],
  },
  {
    id: 'frontend-developer', title: 'Frontend Developer', sector: 'Technology & Software',
    experienceYears: 2,
    requiredSkills: ['javascript', 'react', 'html', 'css', 'typescript', 'git'],
  },
  {
    id: 'data-analyst', title: 'Data Analyst', sector: 'Technology & Software',
    experienceYears: 2,
    requiredSkills: ['sql', 'excel', 'python', 'power bi', 'tableau', 'data analysis'],
  },
  {
    id: 'data-scientist', title: 'Data Scientist', sector: 'Technology & Software',
    experienceYears: 3,
    requiredSkills: ['python', 'machine learning', 'sql', 'tensorflow', 'statistics', 'nlp'],
  },
  {
    id: 'devops-engineer', title: 'DevOps Engineer', sector: 'Technology & Software',
    experienceYears: 3,
    requiredSkills: ['docker', 'kubernetes', 'aws', 'linux', 'ci/cd', 'terraform', 'python'],
  },
  // ── Management ────────────────────────────────────────────────────────────
  {
    id: 'product-manager', title: 'Product Manager', sector: 'Technology & Software',
    experienceYears: 4,
    requiredSkills: ['product management', 'agile', 'scrum', 'jira', 'stakeholder', 'roadmap'],
  },
  {
    id: 'engineering-manager', title: 'Engineering Manager', sector: 'Technology & Software',
    experienceYears: 6,
    requiredSkills: ['leadership', 'agile', 'system design', 'mentoring', 'code review', 'scrum'],
  },
  {
    id: 'project-manager', title: 'Project Manager', sector: 'Consulting',
    experienceYears: 4,
    requiredSkills: ['project management', 'agile', 'scrum', 'jira', 'budgeting', 'stakeholder'],
  },
  // ── HR ────────────────────────────────────────────────────────────────────
  {
    id: 'hr-manager', title: 'HR Manager', sector: 'HR & Administration',
    experienceYears: 5,
    requiredSkills: ['recruitment', 'payroll', 'compliance', 'excel', 'communication', 'leadership'],
  },
  // ── Marketing ─────────────────────────────────────────────────────────────
  {
    id: 'digital-marketing', title: 'Digital Marketing Specialist', sector: 'Marketing',
    experienceYears: 2,
    requiredSkills: ['seo', 'google analytics', 'facebook ads', 'content marketing', 'excel'],
  },
  // ── Sales ─────────────────────────────────────────────────────────────────
  {
    id: 'sales-executive', title: 'Sales Executive', sector: 'Sales',
    experienceYears: 1,
    requiredSkills: ['communication', 'crm', 'negotiation', 'excel', 'leadership'],
  },
];

async function _fetchRolesWithSkills() {
  const cacheKey = 'job-matching:roles-with-skills';
  try {
    const hit = await cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch (_) {}

  // ── Step 1: Fetch roles from Firestore ────────────────────────────────────
  let firestoreRoles = [];
  try {
    const rolesSnap = await db.collection('roles')
      .where('softDeleted', '!=', true)
      .limit(500)
      .get();
    firestoreRoles = rolesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) {}

  // ── Step 2: Build skills map from Firestore ───────────────────────────────
  // FIX: Try BOTH 'roleSkills' (seed name) AND 'role_skills' (legacy name).
  // Also read skills[] array directly from the roleSkills doc (seed stores them there).
  const skillsMap = {}; // roleId → string[]

  // Try roleSkills collection first (what the seed script actually creates)
  try {
    const snap = await db.collection('roleSkills').get();
    if (!snap.empty) {
      snap.forEach(doc => {
        const d = doc.data();
        const roleId = d.roleId || doc.id;
        // Skills stored as array on the doc: skills[].name
        if (Array.isArray(d.skills) && d.skills.length > 0) {
          skillsMap[roleId] = d.skills
            .map(s => (typeof s === 'string' ? s : s?.name || s?.skill_name || '').toLowerCase())
            .filter(Boolean);
        }
        // Also try skillTags (seedRoles.js format)
        if (!skillsMap[roleId] && Array.isArray(d.skillTags)) {
          skillsMap[roleId] = d.skillTags.map(s => s.toLowerCase()).filter(Boolean);
        }
      });
    }
  } catch (_) {}

  // Also try role_skills (sub-doc per skill format)
  if (Object.keys(skillsMap).length === 0) {
    try {
      const roleIds = firestoreRoles.map(r => r.id);
      const BATCH = 10;
      for (let i = 0; i < roleIds.length; i += BATCH) {
        const chunk = roleIds.slice(i, i + BATCH);
        const snaps = await Promise.all(
          chunk.map(id => db.collection('role_skills').where('role_id', '==', id).get())
        );
        for (let j = 0; j < chunk.length; j++) {
          const roleId = chunk[j];
          skillsMap[roleId] = snaps[j].docs
            .map(d => (d.data().skill_name || d.data().name || '').toLowerCase())
            .filter(Boolean);
        }
      }
    } catch (_) {}
  }

  // Also pull skillTags directly from roles docs (seedRoles.js stores them there)
  for (const role of firestoreRoles) {
    if (!skillsMap[role.id] && Array.isArray(role.skillTags) && role.skillTags.length > 0) {
      skillsMap[role.id] = role.skillTags.map(s => s.toLowerCase()).filter(Boolean);
    }
  }

  // ── Step 3: Fetch salary bands ────────────────────────────────────────────
  const salaryMap = {};
  try {
    const salarySnap = await db.collection('salaryBands').get();
    salarySnap.forEach(d => { salaryMap[d.id] = d.data(); });
  } catch (_) {}

  // ── Step 4: Enrich Firestore roles with resolved skills ───────────────────
  const enrichedFirestore = firestoreRoles.map(role => ({
    id:              role.id,
    title:           role.title || role.name || 'Unknown Role',
    sector:          role.sector || role.category || null,
    requiredSkills:  skillsMap[role.id] || [],
    salary:          salaryMap[role.id] || null,
    experienceYears: role.experienceYears || role.minExperienceYears || 0,
  }));

  // ── Step 5: Merge with BUILT_IN_ROLES ─────────────────────────────────────
  // Built-ins fill the gaps: finance roles, any roles missing from Firestore seed.
  // If Firestore has a role with the same id, it takes precedence.
  const firestoreIds = new Set(enrichedFirestore.map(r => r.id));
  const builtInOnly  = BUILT_IN_ROLES.filter(r => !firestoreIds.has(r.id));

  const allRoles = [...enrichedFirestore, ...builtInOnly];

  // ── Step 6: Drop roles that still have no skills (they can't score accurately) ──
  const scoreable = allRoles.filter(r => r.requiredSkills.length > 0);
  const final     = scoreable.length > 0 ? scoreable : allRoles; // fallback: keep all

  try {
    await cache.set(cacheKey, JSON.stringify(final), 'EX', 1800); // 30 min
  } catch (_) {}

  return final;
}

// ─── getJobMatches ────────────────────────────────────────────────────────────

/**
 * Match a user to the top N roles from the platform database.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.limit=10]       — max results
 * @param {number} [options.minScore=30]    — minimum match score to include
 * @returns {Promise<JobMatchResult>}
 */
async function getJobMatches(userId, { limit = 10, minScore = 30 } = {}) {
  const cacheKey = `job-matches:user:${userId}:${limit}`;

  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const user  = await _loadUserProfile(userId);

    if (user.skills.length === 0) {
      return {
        recommended_jobs: [],
        total_roles_evaluated: 0,
        message: 'Complete your onboarding and upload your CV to see job matches.',
      };
    }

    const roles = await _fetchRolesWithSkills();

    if (roles.length === 0) {
      return {
        recommended_jobs: [],
        total_roles_evaluated: 0,
        message: 'No roles found in the system. Ask your admin to sync the job database.',
      };
    }

    // Score every role
    const scored = roles.map(role => {
      const skillScore    = _skillScore(user.skills, role.requiredSkills);
      const expScore      = _experienceScore(user.yearsExperience, role.experienceYears);
      const industryScore = _industryScore(user.industry, role.sector || '');
      const roleScore     = _roleSimilarityScore(user.targetRole, role.title);
      const matchScore    = _compositeScore(skillScore, expScore, industryScore, roleScore);

      // Which required skills does the user NOT have?
      const userSkillSet  = new Set(user.skills);
      const missingSkills = role.requiredSkills
        .filter(s => !userSkillSet.has(s.toLowerCase()))
        .slice(0, 5);

      return {
        id:            role.id,
        title:         role.title,
        sector:        role.sector       || null,
        description:   role.description  || null,
        match_score:   matchScore,
        skill_score:   skillScore,
        experience_score: expScore,
        industry_score:   industryScore,
        role_score:       roleScore,
        missing_skills:   missingSkills,
        salary: role.salary?.levels
          ? Object.values(role.salary.levels)[0] || null
          : null,
      };
    });

    // Sort descending, apply floor, take top N
    const recommended = scored
      .filter(r => r.match_score >= minScore)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, limit);

    logger.info('[JobMatchingEngine] getJobMatches', {
      userId,
      rolesEvaluated: roles.length,
      recommendedCount: recommended.length,
      topScore: recommended[0]?.match_score ?? 0,
    });

    return {
      recommended_jobs:      recommended,
      total_roles_evaluated: roles.length,
      user_skills_count:     user.skills.length,
      target_role:           user.targetRole,
      industry:              user.industry,
    };
  });
}

/**
 * Get detailed recommendations including learning paths for missing skills.
 * Heavier version of getJobMatches — top 5 only with enriched data.
 *
 * @param {string} userId
 * @returns {Promise<RecommendationsResult>}
 */
async function getRecommendations(userId) {
  const cacheKey = `job-recommendations:user:${userId}`;

  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const matches = await getJobMatches(userId, { limit: 5, minScore: 20 });

    return {
      ...matches,
      summary: matches.recommended_jobs.length > 0
        ? `Your top match is "${matches.recommended_jobs[0]?.title}" with a ${matches.recommended_jobs[0]?.match_score}% fit score.`
        : 'No strong matches found yet. Add more skills to improve your match rate.',
    };
  });
}

/**
 * invalidateUserMatchCache(userId)
 *
 * Call this immediately after a user uploads/updates their CV so the next
 * dashboard load recomputes matches with the fresh skill set instead of
 * serving the stale 10-minute cached result.
 */
async function invalidateUserMatchCache(userId) {
  try {
    await Promise.all([
      cache.del(`job-matches:user:${userId}:10`),
      cache.del(`job-matches:user:${userId}:5`),
      cache.del(`job-recommendations:user:${userId}`),
    ]);
    logger.debug('[JobMatchingEngine] Cache invalidated for user', { userId });
  } catch (err) {
    logger.warn('[JobMatchingEngine] Cache invalidation failed (non-fatal)', { error: err.message });
  }
}

module.exports = { getJobMatches, getRecommendations, invalidateUserMatchCache };








