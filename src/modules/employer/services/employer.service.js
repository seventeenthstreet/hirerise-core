'use strict';

/**
 * services/employer.service.js
 *
 * Business logic for the Employer Integration Layer.
 *
 * Privacy guarantee:
 *   No student PII (name, email, UID) is returned from any employer-facing method.
 *   All talent data is aggregated and anonymised at the service layer.
 */

'use strict';

const logger  = require('../../../utils/logger');
const empRepo = require('../repositories/employer.repository');
const { EMPLOYER_ROLES } = require('../models/employer.model');
const matchingService = require('../../opportunities/services/studentMatching.service');

// ─── Employer CRUD ────────────────────────────────────────────────────────────

async function createEmployer(userId, fields) {
  if (!fields.company_name?.trim()) {
    const err = new Error('company_name is required.');
    err.statusCode = 400;
    throw err;
  }

  const employer = await empRepo.createEmployer(userId, {
    company_name: fields.company_name.trim(),
    industry:     (fields.industry || '').trim(),
    website:      (fields.website  || '').trim(),
  });

  // Creator becomes admin
  await empRepo.addEmployerUser(employer.id, userId, EMPLOYER_ROLES.ADMIN);

  return { employer };
}

async function getMyEmployers(userId) {
  const employers = await empRepo.getMyEmployers(userId);
  return { employers };
}

async function getEmployer(employerId) {
  const employer = await empRepo.getEmployer(employerId);
  if (!employer) {
    const err = new Error('Employer not found.');
    err.statusCode = 404;
    throw err;
  }
  return { employer };
}

// ─── Job Role CRUD ────────────────────────────────────────────────────────────

async function createJobRole(employerId, fields) {
  if (!fields.role_name?.trim()) {
    const err = new Error('role_name is required.');
    err.statusCode = 400;
    throw err;
  }
  const role = await empRepo.createJobRole(employerId, {
    role_name:       fields.role_name.trim(),
    required_skills: fields.required_skills || [],
    salary_min:      fields.salary_min,
    salary_max:      fields.salary_max,
    currency:        fields.currency || 'USD',
    streams:         fields.streams  || [],
    exp_min:         fields.exp_min,
    exp_max:         fields.exp_max,
  });
  return { role };
}

async function listJobRoles(employerId) {
  const roles = await empRepo.listJobRoles(employerId);
  return { roles };
}

async function updateJobRole(employerId, roleId, fields) {
  const role = await empRepo.getJobRole(roleId);
  if (!role || role.employer_id !== employerId) {
    const err = new Error('Job role not found for this employer.');
    err.statusCode = 404;
    throw err;
  }
  const updated = await empRepo.updateJobRole(roleId, fields);
  return { role: updated };
}

async function deactivateJobRole(employerId, roleId) {
  const role = await empRepo.getJobRole(roleId);
  if (!role || role.employer_id !== employerId) {
    const err = new Error('Job role not found for this employer.');
    err.statusCode = 404;
    throw err;
  }
  await empRepo.deactivateJobRole(roleId);
  return { deactivated: true };
}

// ─── Talent Pipeline Analytics (aggregated, no PII) ──────────────────────────

/**
 * getTalentPipeline(employerId)
 *
 * Returns per-role talent pipeline stats:
 *   - total students matching each role
 *   - skill gap analysis
 *   - stream distribution
 */
async function getTalentPipeline(employerId) {
  const { roles } = await listJobRoles(employerId);

  if (!roles.length) {
    return {
      employer_id:  employerId,
      total_roles:  0,
      total_talent: 0,
      roles:        [],
    };
  }

  const roleStats = await Promise.all(
    roles.map(async role => {
      try {
        const stats = await matchingService.getMatchedStudentsForJobRole(role.id);
        return {
          role_id:         role.id,
          role_name:       role.role_name,
          required_skills: role.required_skills,
          salary_range:    role.salary_range,
          pipeline_count:  stats.total_pipeline,
          avg_match_score: stats.avg_match_score,
          skill_gap:       (stats.skill_gap_analysis || []).slice(0, 5),
          stream_distribution: stats.stream_distribution || [],
        };
      } catch (err) {
        logger.warn({ err: err.message, roleId: role.id }, '[EmployerService] talent pipeline fetch failed');
        return {
          role_id:         role.id,
          role_name:       role.role_name,
          required_skills: role.required_skills,
          salary_range:    role.salary_range,
          pipeline_count:  0,
          avg_match_score: 0,
          skill_gap:       [],
          stream_distribution: [],
        };
      }
    })
  );

  const totalTalent = roleStats.reduce((sum, r) => sum + r.pipeline_count, 0);

  // Aggregate skill trend across all roles
  const skillFreq = {};
  for (const r of roleStats) {
    for (const sk of r.required_skills) {
      skillFreq[sk] = (skillFreq[sk] || 0) + 1;
    }
  }
  const skillTrends = Object.entries(skillFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([skill, demand_count]) => ({ skill, demand_count }));

  return {
    employer_id:  employerId,
    total_roles:  roles.length,
    total_talent: totalTalent,
    skill_trends: skillTrends,
    roles: roleStats.sort((a, b) => b.pipeline_count - a.pipeline_count),
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









