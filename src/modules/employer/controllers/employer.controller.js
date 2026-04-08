'use strict';

/**
 * src/modules/employer/controllers/employer.controller.js
 *
 * Employer Integration HTTP Controller
 * -----------------------------------
 * Responsibilities:
 * - request extraction
 * - lightweight input validation
 * - auth-safe user identity extraction
 * - service delegation
 * - normalized API responses
 * - structured error logging
 *
 * Supabase migration notes:
 * - removed Firebase-style req.user.id assumption
 * - now supports Supabase req.user.id as primary identity
 * - backward-safe fallback for legacy middleware during rollout
 */

const logger = require('../../../utils/logger');
const employerService = require('../services/employer.service');
const matchingService = require('../../opportunities/services/studentMatching.service');

/**
 * Standard success response
 */
function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

/**
 * Standard error response
 */
function fail(res, statusCode, message, code = 'EMPLOYER_ERROR') {
  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code,
    },
  });
}

/**
 * Supabase-safe authenticated user extraction
 *
 * Supports:
 * - req.user.id     → Supabase standard
 * - req.user.id    → legacy Firebase compatibility during migration
 */
function getAuthenticatedUserId(req) {
  return req?.user?.id || req?.user?.uid || null;
}

/**
 * Unified controller error handler
 */
function handleControllerError(res, err, context) {
  logger.error(
    {
      context,
      message: err?.message,
      code: err?.code,
      statusCode: err?.statusCode,
      stack: err?.stack,
    },
    `[EmployerController] ${context}`
  );

  return fail(
    res,
    err?.statusCode || 500,
    err?.message || 'Internal server error.',
    err?.code || 'EMPLOYER_ERROR'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/employer
// ─────────────────────────────────────────────────────────────────────────────

async function createEmployer(req, res) {
  const userId = getAuthenticatedUserId(req);
  const { company_name, industry, website } = req.body ?? {};

  if (!userId) {
    return fail(res, 401, 'Unauthorized.', 'UNAUTHORIZED');
  }

  if (!company_name?.trim()) {
    return fail(res, 400, 'company_name is required.', 'MISSING_NAME');
  }

  try {
    const result = await employerService.createEmployer(userId, {
      company_name: company_name.trim(),
      industry: industry ?? null,
      website: website ?? null,
    });

    return ok(res, result, 201);
  } catch (err) {
    return handleControllerError(res, err, 'createEmployer');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/employer/my
// ─────────────────────────────────────────────────────────────────────────────

async function getMyEmployers(req, res) {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return fail(res, 401, 'Unauthorized.', 'UNAUTHORIZED');
  }

  try {
    const result = await employerService.getMyEmployers(userId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, 'getMyEmployers');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/employer/:employerId
// ─────────────────────────────────────────────────────────────────────────────

async function getEmployer(req, res) {
  const { employerId } = req.params;

  try {
    const result = await employerService.getEmployer(employerId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, 'getEmployer');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/employer/:employerId/roles
// ─────────────────────────────────────────────────────────────────────────────

async function createJobRole(req, res) {
  const { employerId } = req.params;
  const {
    role_name,
    required_skills,
    salary_min,
    salary_max,
    currency,
    streams,
    exp_min,
    exp_max,
  } = req.body ?? {};

  if (!role_name?.trim()) {
    return fail(res, 400, 'role_name is required.', 'MISSING_ROLE_NAME');
  }

  try {
    const result = await employerService.createJobRole(employerId, {
      role_name: role_name.trim(),
      required_skills: required_skills ?? [],
      salary_min: salary_min ?? null,
      salary_max: salary_max ?? null,
      currency: currency ?? null,
      streams: streams ?? [],
      exp_min: exp_min ?? null,
      exp_max: exp_max ?? null,
    });

    return ok(res, result, 201);
  } catch (err) {
    return handleControllerError(res, err, 'createJobRole');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/employer/:employerId/roles
// ─────────────────────────────────────────────────────────────────────────────

async function listJobRoles(req, res) {
  const { employerId } = req.params;

  try {
    const result = await employerService.listJobRoles(employerId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, 'listJobRoles');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/employer/:employerId/roles/:roleId
// ─────────────────────────────────────────────────────────────────────────────

async function updateJobRole(req, res) {
  const { employerId, roleId } = req.params;

  try {
    const result = await employerService.updateJobRole(
      employerId,
      roleId,
      req.body ?? {}
    );

    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, 'updateJobRole');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/employer/:employerId/roles/:roleId
// ─────────────────────────────────────────────────────────────────────────────

async function deactivateJobRole(req, res) {
  const { employerId, roleId } = req.params;

  try {
    const result = await employerService.deactivateJobRole(employerId, roleId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, 'deactivateJobRole');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/employer/:employerId/talent-pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function getTalentPipeline(req, res) {
  const { employerId } = req.params;

  try {
    const result = await employerService.getTalentPipeline(employerId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, 'getTalentPipeline');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/employer/:employerId/roles/:roleId/matches
// ─────────────────────────────────────────────────────────────────────────────

async function getRoleMatches(req, res) {
  const { roleId } = req.params;

  try {
    const result = await matchingService.getMatchedStudentsForJobRole(roleId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, 'getRoleMatches');
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