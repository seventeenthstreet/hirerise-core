'use strict';

/**
 * controllers/school.controller.js
 *
 * HTTP controller for the School & Counselor Platform.
 * Thin layer: extract → validate → call service → respond.
 *
 * All endpoints require authenticate middleware (inherited from route mount).
 * Role-based guards (requireSchoolMember / requireSchoolAdmin) are applied
 * per route in school.routes.js.
 */

const logger        = require('../../../utils/logger');
const schoolService = require('../services/school.service');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function fail(res, statusCode, message, code = 'SCHOOL_ERROR') {
  return res.status(statusCode).json({ success: false, error: { message, code } });
}

// ─── POST /api/v1/school ──────────────────────────────────────────────────────

async function createSchool(req, res) {
  const { school_name, location } = req.body;

  if (!school_name || !school_name.trim()) {
    return fail(res, 400, 'school_name is required.', 'MISSING_SCHOOL_NAME');
  }

  try {
    const result = await schoolService.createSchool(req.user.uid, { school_name, location });
    return ok(res, result, 201);
  } catch (err) {
    logger.error({ err: err.message }, '[SchoolController] createSchool error');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/school/my ────────────────────────────────────────────────────

async function getMySchools(req, res) {
  try {
    const result = await schoolService.getMySchools(req.user.uid);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/school/:schoolId ─────────────────────────────────────────────

async function getSchool(req, res) {
  try {
    const result = await schoolService.getSchool(req.params.schoolId);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── POST /api/v1/school/:schoolId/counselors ─────────────────────────────────

async function addCounselor(req, res) {
  const { email } = req.body;

  if (!email) {
    return fail(res, 400, 'email is required.', 'MISSING_EMAIL');
  }

  try {
    const result = await schoolService.addCounselor(req.params.schoolId, email);
    return ok(res, result, 201);
  } catch (err) {
    logger.error({ err: err.message }, '[SchoolController] addCounselor error');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/school/:schoolId/counselors ──────────────────────────────────

async function getCounselors(req, res) {
  try {
    const result = await schoolService.getCounselors(req.params.schoolId);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/school/:schoolId/students ────────────────────────────────────

async function listStudents(req, res) {
  try {
    const result = await schoolService.listStudents(req.params.schoolId);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── POST /api/v1/school/:schoolId/students/import ────────────────────────────

async function importStudents(req, res) {
  if (!req.file) {
    return fail(res, 400, 'CSV file is required. Upload a file with field name "file".', 'NO_FILE');
  }

  try {
    const result = await schoolService.importStudentsCSV(req.params.schoolId, req.file.buffer);

    const statusCode = result.imported > 0 && result.skipped > 0 ? 207
      : result.imported > 0 ? 201
      : 422;

    return res.status(statusCode).json({
      success: result.imported > 0,
      data:    result,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[SchoolController] importStudents error');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── POST /api/v1/school/:schoolId/run-assessment/:studentId ─────────────────

async function runAssessment(req, res) {
  const { schoolId, studentId } = req.params;

  try {
    const result = await schoolService.runAssessment(schoolId, studentId);
    return ok(res, result);
  } catch (err) {
    logger.error({ err: err.message, schoolId, studentId }, '[SchoolController] runAssessment error');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/school/:schoolId/student-report/:studentId ──────────────────

async function getStudentReport(req, res) {
  const { schoolId, studentId } = req.params;

  try {
    const result = await schoolService.getStudentReport(schoolId, studentId);
    return ok(res, result);
  } catch (err) {
    logger.error({ err: err.message, schoolId, studentId }, '[SchoolController] getStudentReport error');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── GET /api/v1/school/:schoolId/analytics ───────────────────────────────────

async function getAnalytics(req, res) {
  try {
    const result = await schoolService.getAnalytics(req.params.schoolId);
    return ok(res, result);
  } catch (err) {
    logger.error({ err: err.message }, '[SchoolController] getAnalytics error');
    return fail(res, err.statusCode || 500, err.message);
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









