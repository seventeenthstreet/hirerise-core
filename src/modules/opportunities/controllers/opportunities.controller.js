'use strict';

/**
 * src/modules/opportunities/controllers/opportunities.controller.js
 *
 * Student-facing Opportunities endpoint.
 *
 * GET /api/v1/opportunities/:studentId
 *
 * Returns matched university programs and job roles for a student.
 * Students can only fetch their own opportunities.
 * Admins can fetch any student's opportunities.
 *
 * Supabase Migration Notes:
 * - Fully Firebase-free
 * - Auth payload normalized for Supabase JWT compatibility
 * - Improved null safety and authorization checks
 * - Hardened async error flow
 * - Consistent structured logging
 */

const logger = require('../../../utils/logger');
const matchingService = require('../services/studentMatching.service');

/**
 * Standard success response
 */
function ok(res, data) {
  return res.status(200).json({
    success: true,
    data,
  });
}

/**
 * Standard error response
 */
function fail(
  res,
  statusCode,
  message,
  code = 'OPPORTUNITIES_ERROR'
) {
  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code,
    },
  });
}

/**
 * Normalize authenticated user id across legacy + Supabase middleware.
 *
 * Supports:
 * - Firebase legacy: req.user.id
 * - Supabase JWT: req.user.id
 * - JWT standard: req.user.sub
 */
function getAuthenticatedUserId(user) {
  return user?.id || user?.uid || user?.sub || null;
}

/**
 * GET /api/v1/opportunities/:studentId
 */
async function getOpportunities(req, res) {
  const studentId = req.params?.studentId;
  const user = req.user || {};

  if (!studentId) {
    return fail(
      res,
      400,
      'Student ID is required.',
      'INVALID_STUDENT_ID'
    );
  }

  const authenticatedUserId = getAuthenticatedUserId(user);
  const isAdmin =
    user?.admin === true ||
    user?.role === 'admin' ||
    user?.role === 'master_admin';

  if (!authenticatedUserId && !isAdmin) {
    return fail(
      res,
      401,
      'Authentication required.',
      'UNAUTHORIZED'
    );
  }

  /**
   * Authorization:
   * - Admins can fetch any student
   * - Students can only fetch their own data
   */
  if (!isAdmin && authenticatedUserId !== studentId) {
    return fail(
      res,
      403,
      'You can only view your own opportunities.',
      'FORBIDDEN'
    );
  }

  try {
    const result = await matchingService.getOpportunities(studentId);

    return ok(res, result);
  } catch (error) {
    logger.error(
      {
        err: error,
        message: error?.message,
        studentId,
        authenticatedUserId,
        controller: 'opportunities.controller',
        action: 'getOpportunities',
      },
      '[OpportunitiesController] Failed to fetch opportunities'
    );

    return fail(
      res,
      error?.statusCode || 500,
      error?.message || 'Failed to fetch opportunities.',
      error?.code || 'OPPORTUNITIES_FETCH_FAILED'
    );
  }
}

module.exports = Object.freeze({
  getOpportunities,
});