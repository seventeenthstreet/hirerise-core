'use strict';

/**
 * controllers/employer.controller.js
 *
 * HTTP controller for the Employer Integration Layer.
 * Thin layer: extract → validate → call service → respond.
 */

const logger          = require('../../../utils/logger');
const employerService = require('../services/employer.service');
const matchingService = require('../../opportunities/services/studentMatching.service');

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}
function fail(res, statusCode, message, code = 'EMPLOYER_ERROR') {
  return res.status(statusCode).json({ success: false, error: { message, code } });
}

// ─── POST /api/v1/employer ────────────────────────────────────────────────────

async function createEmployer(req, res) {
  const { company_name, industry, website } = req.body;
  if (!company_name?.trim()) {
    return fail(res, 400, 'company_name is required.', 'MISSING_NAME');
  }
  try {
    const result = await employerService.createEmployer(req.user.uid, { company_name, industry, website });
    return ok(res, result, 201);
  } catch (err) {
    logger.error({ err: err.message }, '[EmployerController] createEmployer');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/employer/my ──────────────────────────────────────────────────

async function getMyEmployers(req, res) {
  try {
    const result = await employerService.getMyEmployers(req.user.uid);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/employer/:employerId ────────────────────────────────────────

async function getEmployer(req, res) {
  try {
    const result = await employerService.getEmployer(req.params.employerId);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── POST /api/v1/employer/:employerId/roles ──────────────────────────────────

async function createJobRole(req, res) {
  const { employerId } = req.params;
  const { role_name, required_skills, salary_min, salary_max, currency, streams, exp_min, exp_max } = req.body;
  if (!role_name?.trim()) {
    return fail(res, 400, 'role_name is required.', 'MISSING_ROLE_NAME');
  }
  try {
    const result = await employerService.createJobRole(employerId, {
      role_name, required_skills, salary_min, salary_max, currency, streams, exp_min, exp_max,
    });
    return ok(res, result, 201);
  } catch (err) {
    logger.error({ err: err.message }, '[EmployerController] createJobRole');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/employer/:employerId/roles ───────────────────────────────────

async function listJobRoles(req, res) {
  try {
    const result = await employerService.listJobRoles(req.params.employerId);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── PATCH /api/v1/employer/:employerId/roles/:roleId ────────────────────────

async function updateJobRole(req, res) {
  const { employerId, roleId } = req.params;
  try {
    const result = await employerService.updateJobRole(employerId, roleId, req.body);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── DELETE /api/v1/employer/:employerId/roles/:roleId ───────────────────────

async function deactivateJobRole(req, res) {
  const { employerId, roleId } = req.params;
  try {
    const result = await employerService.deactivateJobRole(employerId, roleId);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/employer/:employerId/talent-pipeline ────────────────────────

async function getTalentPipeline(req, res) {
  try {
    const result = await employerService.getTalentPipeline(req.params.employerId);
    return ok(res, result);
  } catch (err) {
    logger.error({ err: err.message }, '[EmployerController] getTalentPipeline');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/employer/:employerId/roles/:roleId/matches ──────────────────

async function getRoleMatches(req, res) {
  const { roleId } = req.params;
  try {
    const result = await matchingService.getMatchedStudentsForJobRole(roleId);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
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
  getRoleMatches,
};









