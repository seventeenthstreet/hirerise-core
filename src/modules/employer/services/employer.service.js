'use strict';

/**
 * src/modules/employer/services/employer.service.js
 *
 * Employer business logic service
 * -------------------------------
 * Supabase-native service orchestration layer
 * preserving anonymized talent analytics.
 *
 * Changes from previous version:
 * - createEmployer now calls the create_employer_with_admin RPC for atomic
 *   employer + admin membership creation. The previous two-step flow that
 *   could leave an orphan employer row without an admin has been removed.
 * - getTalentPipeline now caps concurrent matchingService calls via p-limit
 *   to prevent unbounded fan-out on employers with many active roles.
 */

const logger = require('../../../utils/logger');
const empRepo = require('../repositories/employer.repository');
const { supabase } = require('../../../config/supabase');
const matchingService = require('../../opportunities/services/studentMatching.service');

// Cap concurrent talent pipeline stat fetches per employer request.
// Adjust based on matchingService throughput limits.
const PIPELINE_CONCURRENCY_LIMIT = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Error helpers
// ─────────────────────────────────────────────────────────────────────────────

function badRequest(message, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

function notFound(message, code = 'NOT_FOUND') {
  const err = new Error(message);
  err.statusCode = 404;
  err.code = code;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency limiter (inline, no external dependency required)
// Replace with p-limit if already in your dependency tree:
//   const pLimit = require('p-limit');
//   const limit = pLimit(PIPELINE_CONCURRENCY_LIMIT);
// ─────────────────────────────────────────────────────────────────────────────

function makeLimit(concurrency) {
  let active = 0;
  const queue = [];

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(() => fn())
      .then(result => { resolve(result); })
      .catch(err => { reject(err); })
      .finally(() => { active--; next(); });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Employer CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically create an employer and assign the creator as employer_admin.
 *
 * Delegates to the create_employer_with_admin DB RPC, which runs both
 * INSERTs in a single transaction — no orphan employer row is possible.
 *
 * @param {string} userId
 * @param {object} fields - { company_name, industry?, website? }
 * @returns {{ employer: object }}
 */
async function createEmployer(userId, fields = {}) {
  if (!fields.company_name?.trim()) {
    throw badRequest('company_name is required.', 'MISSING_COMPANY_NAME');
  }

  const { data, error } = await supabase.rpc('create_employer_with_admin', {
    p_user_id:      userId,
    p_company_name: fields.company_name.trim(),
    p_industry:     fields.industry?.trim?.() || null,
    p_website:      fields.website?.trim?.() || null,
  });

  if (error) {
    // Surface DB-level validation (ERRCODE P0001) as a 400
    if (error.code === 'P0001') {
      throw badRequest(error.message, 'MISSING_COMPANY_NAME');
    }
    logger.error(
      { userId, message: error.message },
      '[EmployerService] create_employer_with_admin RPC failed'
    );
    throw error;
  }

  return { employer: data };
}

/**
 * List all employers the requesting user is a member of.
 * @param {string} userId
 * @returns {{ employers: object[] }}
 */
async function getMyEmployers(userId) {
  const employers = await empRepo.getMyEmployers(userId);
  return { employers };
}

/**
 * Fetch a single employer by ID.
 * @param {string} employerId
 * @returns {{ employer: object }}
 */
async function getEmployer(employerId) {
  const employer = await empRepo.getEmployer(employerId);

  if (!employer) {
    throw notFound('Employer not found.', 'EMPLOYER_NOT_FOUND');
  }

  return { employer };
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Role CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new job role for an employer.
 * @param {string} employerId
 * @param {object} fields
 * @returns {{ role: object }}
 */
async function createJobRole(employerId, fields = {}) {
  if (!fields.role_name?.trim()) {
    throw badRequest('role_name is required.', 'MISSING_ROLE_NAME');
  }

  const role = await empRepo.createJobRole(employerId, {
    role_name:       fields.role_name.trim(),
    required_skills: fields.required_skills ?? [],
    salary_min:      fields.salary_min,
    salary_max:      fields.salary_max,
    currency:        fields.currency || 'USD',
    streams:         fields.streams ?? [],
    exp_min:         fields.exp_min,
    exp_max:         fields.exp_max,
  });

  return { role };
}

/**
 * List all active job roles for an employer.
 * @param {string} employerId
 * @returns {{ roles: object[] }}
 */
async function listJobRoles(employerId) {
  const roles = await empRepo.listJobRoles(employerId);
  return { roles };
}

/**
 * Update a job role, scoped to the owning employer.
 * Ownership is verified before the update is applied.
 * @param {string} employerId
 * @param {string} roleId
 * @param {object} fields
 * @returns {{ role: object }}
 */
async function updateJobRole(employerId, roleId, fields = {}) {
  const role = await empRepo.getJobRole(roleId);

  if (!role || role.employer_id !== employerId) {
    throw notFound(
      'Job role not found for this employer.',
      'JOB_ROLE_NOT_FOUND'
    );
  }

  const updated = await empRepo.updateJobRole(roleId, fields);
  return { role: updated };
}

/**
 * Soft-delete a job role by setting active = false.
 * Ownership is verified before deactivation.
 * @param {string} employerId
 * @param {string} roleId
 * @returns {{ deactivated: true }}
 */
async function deactivateJobRole(employerId, roleId) {
  const role = await empRepo.getJobRole(roleId);

  if (!role || role.employer_id !== employerId) {
    throw notFound(
      'Job role not found for this employer.',
      'JOB_ROLE_NOT_FOUND'
    );
  }

  await empRepo.deactivateJobRole(roleId);
  return { deactivated: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Talent Pipeline Analytics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate talent pipeline stats across all active roles for an employer.
 *
 * Concurrent matchingService calls are capped at PIPELINE_CONCURRENCY_LIMIT
 * to prevent unbounded fan-out. Individual role failures are caught and
 * return zero-filled fallback stats so a single bad role does not block
 * the entire pipeline response.
 *
 * @param {string} employerId
 * @returns {object} Aggregated pipeline report.
 */
async function getTalentPipeline(employerId) {
  const { roles } = await listJobRoles(employerId);

  if (!roles.length) {
    return {
      employer_id:  employerId,
      total_roles:  0,
      total_talent: 0,
      skill_trends: [],
      roles:        [],
    };
  }

  const limit = makeLimit(PIPELINE_CONCURRENCY_LIMIT);

  const roleStats = await Promise.all(
    roles.map(role =>
      limit(async () => {
        try {
          const stats = await matchingService.getMatchedStudentsForJobRole(role.id);

          return {
            role_id:             role.id,
            role_name:           role.role_name,
            required_skills:     role.required_skills ?? [],
            salary_range:        role.salary_range ?? {},
            pipeline_count:      stats?.total_pipeline ?? 0,
            avg_match_score:     stats?.avg_match_score ?? 0,
            skill_gap:           (stats?.skill_gap_analysis ?? []).slice(0, 5),
            stream_distribution: stats?.stream_distribution ?? [],
          };
        } catch (err) {
          logger.warn(
            { roleId: role.id, message: err?.message },
            '[EmployerService] talent pipeline role stats failed'
          );

          return {
            role_id:             role.id,
            role_name:           role.role_name,
            required_skills:     role.required_skills ?? [],
            salary_range:        role.salary_range ?? {},
            pipeline_count:      0,
            avg_match_score:     0,
            skill_gap:           [],
            stream_distribution: [],
          };
        }
      })
    )
  );

  const totalTalent = roleStats.reduce(
    (sum, r) => sum + r.pipeline_count,
    0
  );

  const skillFrequency = {};
  for (const r of roleStats) {
    for (const skill of r.required_skills) {
      skillFrequency[skill] = (skillFrequency[skill] || 0) + 1;
    }
  }

  const skillTrends = Object.entries(skillFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([skill, demand_count]) => ({ skill, demand_count }));

  return {
    employer_id:  employerId,
    total_roles:  roles.length,
    total_talent: totalTalent,
    skill_trends: skillTrends,
    roles:        roleStats.sort((a, b) => b.pipeline_count - a.pipeline_count),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  createEmployer,
  getMyEmployers,
  getEmployer,
  createJobRole,
  listJobRoles,
  updateJobRole,
  deactivateJobRole,
  getTalentPipeline,
};