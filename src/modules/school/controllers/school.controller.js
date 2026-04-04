'use strict';

/**
 * src/modules/school/controllers/school.controller.js
 *
 * HTTP controller for the School & Counselor Platform.
 * Fully Supabase-safe controller layer.
 *
 * Responsibilities:
 * - Validate HTTP input
 * - Normalize auth payload
 * - Delegate business logic to service layer
 * - Standardize API responses
 * - Centralize error logging
 *
 * Notes:
 * - Supports both req.user.id (Supabase) and req.user.uid (legacy Firebase)
 *   for safe zero-downtime rollout.
 * - No DB logic should exist here.
 */

const logger = require('../../../utils/logger');
const schoolService = require('../services/school.service');

/* ──────────────────────────────────────────────────────────────
 * Response helpers
 * ────────────────────────────────────────────────────────────── */
function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

function fail(res, statusCode, message, code = 'SCHOOL_ERROR') {
  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code,
    },
  });
}

/* ──────────────────────────────────────────────────────────────
 * Auth normalization helper
 * Removes legacy Firebase assumption: req.user.uid
 * ────────────────────────────────────────────────────────────── */
function getAuthenticatedUserId(req) {
  return req?.user?.id || req?.user?.uid || null;
}

/* ──────────────────────────────────────────────────────────────
 * Error handling helper
 * ────────────────────────────────────────────────────────────── */
function handleControllerError(res, err, context = {}) {
  logger.error(
    {
      err: err?.message,
      stack: err?.stack,
      ...context,
    },
    '[SchoolController] request failed'
  );

  return fail(
    res,
    err?.statusCode || 500,
    err?.message || 'Internal server error.',
    err?.code || 'SCHOOL_ERROR'
  );
}

/* ──────────────────────────────────────────────────────────────
 * POST /api/v1/school
 * ────────────────────────────────────────────────────────────── */
async function createSchool(req, res) {
  const school_name = req.body?.school_name?.trim();
  const location = req.body?.location ?? null;
  const userId = getAuthenticatedUserId(req);

  if (!school_name) {
    return fail(res, 400, 'school_name is required.', 'MISSING_SCHOOL_NAME');
  }

  if (!userId) {
    return fail(res, 401, 'Unauthorized.', 'UNAUTHORIZED');
  }

  try {
    const result = await schoolService.createSchool(userId, {
      school_name,
      location,
    });

    return ok(res, result, 201);
  } catch (err) {
    return handleControllerError(res, err, { userId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /api/v1/school/my
 * ────────────────────────────────────────────────────────────── */
async function getMySchools(req, res) {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return fail(res, 401, 'Unauthorized.', 'UNAUTHORIZED');
  }

  try {
    const result = await schoolService.getMySchools(userId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, { userId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /api/v1/school/:schoolId
 * ────────────────────────────────────────────────────────────── */
async function getSchool(req, res) {
  const { schoolId } = req.params;

  try {
    const result = await schoolService.getSchool(schoolId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, { schoolId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * POST /api/v1/school/:schoolId/counselors
 * ────────────────────────────────────────────────────────────── */
async function addCounselor(req, res) {
  const { schoolId } = req.params;
  const email = req.body?.email?.trim();

  if (!email) {
    return fail(res, 400, 'email is required.', 'MISSING_EMAIL');
  }

  try {
    const result = await schoolService.addCounselor(schoolId, email);
    return ok(res, result, 201);
  } catch (err) {
    return handleControllerError(res, err, { schoolId, email });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /api/v1/school/:schoolId/counselors
 * ────────────────────────────────────────────────────────────── */
async function getCounselors(req, res) {
  const { schoolId } = req.params;

  try {
    const result = await schoolService.getCounselors(schoolId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, { schoolId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /api/v1/school/:schoolId/students
 * ────────────────────────────────────────────────────────────── */
async function listStudents(req, res) {
  const { schoolId } = req.params;

  try {
    const result = await schoolService.listStudents(schoolId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, { schoolId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * POST /api/v1/school/:schoolId/students/import
 * ────────────────────────────────────────────────────────────── */
async function importStudents(req, res) {
  const { schoolId } = req.params;

  if (!req.file?.buffer) {
    return fail(
      res,
      400,
      'CSV file is required. Upload a file with field name "file".',
      'NO_FILE'
    );
  }

  try {
    const result = await schoolService.importStudentsCSV(
      schoolId,
      req.file.buffer
    );

    const statusCode =
      result.imported > 0 && result.skipped > 0
        ? 207
        : result.imported > 0
          ? 201
          : 422;

    return res.status(statusCode).json({
      success: result.imported > 0,
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, { schoolId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * POST /api/v1/school/:schoolId/run-assessment/:studentId
 * ────────────────────────────────────────────────────────────── */
async function runAssessment(req, res) {
  const { schoolId, studentId } = req.params;

  try {
    const result = await schoolService.runAssessment(schoolId, studentId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, { schoolId, studentId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /api/v1/school/:schoolId/student-report/:studentId
 * ────────────────────────────────────────────────────────────── */
async function getStudentReport(req, res) {
  const { schoolId, studentId } = req.params;

  try {
    const result = await schoolService.getStudentReport(
      schoolId,
      studentId
    );
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, { schoolId, studentId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /api/v1/school/:schoolId/analytics
 * ────────────────────────────────────────────────────────────── */
async function getAnalytics(req, res) {
  const { schoolId } = req.params;

  try {
    const result = await schoolService.getAnalytics(schoolId);
    return ok(res, result);
  } catch (err) {
    return handleControllerError(res, err, { schoolId });
  }
}

module.exports = {
  createSchool,
  getMySchools,
  getSchool,
  addCounselor,
  getCounselors,
  listStudents,
  importStudents,
  runAssessment,
  getStudentReport,
  getAnalytics,
};