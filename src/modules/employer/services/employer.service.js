'use strict';

/**
 * src/modules/employer/services/employer.service.js
 *
 * Employer business logic service
 * --------------------------------
 * Wave 1 hardened:
 * - drift-safe create_employer_with_admin RPC
 * - nullable payload normalization
 * - unique violation normalization
 * - input validation hardening
 * - bounded talent pipeline concurrency
 */

const logger = require('../../../utils/logger');
const empRepo = require('../repositories/employer.repository');
const { supabase } = require('../../../config/supabase');
const matchingService = require('../../opportunities/services/studentMatching.service');

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
// Concurrency limiter
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
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        next();
      });
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
 * Normalize RPC payloads:
 * - object
 * - array row
 * - scalar UUID
 */
function normalizeEmployerRpcResult(data) {
  if (!data) return null;

  if (Array.isArray(data)) {
    return data[0] ?? null;
  }

  if (typeof data === 'string') {
    return { id: data };
  }

  return data;
}

/**
 * Atomically create employer + admin membership
 */
async function createEmployer(userId, fields = {}) {
  const companyName = String(fields.company_name || '').trim();
  const industry = fields.industry?.trim?.() || null;
  const website = fields.website?.trim?.() || null;

  if (!companyName) {
    throw badRequest(
      'company_name is required.',
      'MISSING_COMPANY_NAME'
    );
  }

  if (companyName.length > 160) {
    throw badRequest(
      'company_name exceeds maximum length.',
      'INVALID_COMPANY_NAME'
    );
  }

  if (website && website.length > 300) {
    throw badRequest(
      'website exceeds maximum length.',
      'INVALID_WEBSITE'
    );
  }

  const { data, error } = await supabase.rpc(
    'create_employer_with_admin',
    {
      p_user_id: userId,
      p_company_name: companyName,
      p_industry: industry,
      p_website: website,
    }
  );

  if (error) {
    if (error.code === 'P0001') {
      throw badRequest(
        error.message,
        'EMPLOYER_VALIDATION_FAILED'
      );
    }

    if (error.code === '23505') {
      throw badRequest(
        'Employer already exists.',
        'EMPLOYER_ALREADY_EXISTS'
      );
    }

    logger.error(
      {
        rpc: 'create_employer_with_admin',
        userId,
        companyName,
        code: error.code,
        message: error.message,
        details: error.details,
      },
      '[EmployerService] RPC failed'
    );

    throw error;
  }

  const employer = normalizeEmployerRpcResult(data);

  if (!employer) {
    logger.error(
      {
        rpc: 'create_employer_with_admin',
        userId,
        companyName,
      },
      '[EmployerService] RPC returned empty payload'
    );

    throw new Error(
      'Employer creation transaction returned empty result.'
    );
  }

  return { employer };
}

/**
 * List all employers the requesting user is a member of
 */
async function getMyEmployers(userId) {
  const employers = await empRepo.getMyEmployers(userId);
  return { employers };
}

/**
 * Fetch single employer
 */
async function getEmployer(employerId) {
  const employer = await empRepo.getEmployer(employerId);

  if (!employer) {
    throw notFound(
      'Employer not found.',
      'EMPLOYER_NOT_FOUND'
    );
  }

  return { employer };
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Role CRUD
// ─────────────────────────────────────────────────────────────────────────────

async function createJobRole(employerId, fields = {}) {
  if (!fields.role_name?.trim()) {
    throw badRequest(
      'role_name is required.',
      'MISSING_ROLE_NAME'
    );
  }

  const role = await empRepo.createJobRole(employerId, {
    role_name: fields.role_name.trim(),
    required_skills: fields.required_skills ?? [],
    salary_min: fields.salary_min,
    salary_max: fields.salary_max,
    currency: fields.currency || 'USD',
    streams: fields.streams ?? [],
    exp_min: fields.exp_min,
    exp_max: fields.exp_max,
  });

  return { role };
}

async function listJobRoles(employerId) {
  const roles = await empRepo.listJobRoles(employerId);
  return { roles };
}

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

async function getTalentPipeline(employerId) {
  const { roles } = await listJobRoles(employerId);

  if (!roles.length) {
    return {
      employer_id: employerId,
      total_roles: 0,
      total_talent: 0,
      skill_trends: [],
      roles: [],
    };
  }

  const limit = makeLimit(PIPELINE_CONCURRENCY_LIMIT);

  const roleStats = await Promise.all(
    roles.map(role =>
      limit(async () => {
        try {
          const stats =
            await matchingService.getMatchedStudentsForJobRole(role.id);

          return {
            role_id: role.id,
            role_name: role.role_name,
            required_skills: role.required_skills ?? [],
            salary_range: role.salary_range ?? {},
            pipeline_count: stats?.total_pipeline ?? 0,
            avg_match_score: stats?.avg_match_score ?? 0,
            skill_gap: (stats?.skill_gap_analysis ?? []).slice(0, 5),
            stream_distribution: stats?.stream_distribution ?? [],
          };
        } catch (err) {
          logger.warn(
            {
              roleId: role.id,
              message: err?.message,
            },
            '[EmployerService] talent pipeline role stats failed'
          );

          return {
            role_id: role.id,
            role_name: role.role_name,
            required_skills: role.required_skills ?? [],
            salary_range: role.salary_range ?? {},
            pipeline_count: 0,
            avg_match_score: 0,
            skill_gap: [],
            stream_distribution: [],
          };
        }
      })
    )
  );

  const totalTalent = roleStats.reduce(
    (sum, role) => sum + role.pipeline_count,
    0
  );

  const skillFrequency = {};

  for (const role of roleStats) {
    for (const skill of role.required_skills) {
      skillFrequency[skill] =
        (skillFrequency[skill] || 0) + 1;
    }
  }

  const skillTrends = Object.entries(skillFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([skill, demand_count]) => ({
      skill,
      demand_count,
    }));

  return {
    employer_id: employerId,
    total_roles: roles.length,
    total_talent: totalTalent,
    skill_trends: skillTrends,
    roles: roleStats.sort(
      (a, b) => b.pipeline_count - a.pipeline_count
    ),
  };
}

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