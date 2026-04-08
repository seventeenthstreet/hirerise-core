'use strict';

/**
 * src/modules/school/middleware/school.middleware.js
 *
 * Role-based access control middleware for the School & Counselor Platform.
 *
 * Responsibilities:
 * - Validate schoolId path param
 * - Resolve authenticated user membership role
 * - Support platform admin bypass
 * - Attach req.schoolRole
 * - Enforce role authorization
 *
 * Supabase migration notes:
 * - Fully removes Firebase auth payload assumptions
 * - Supports temporary backward compatibility with req.user.id
 * - Optimized for minimal DB round trips
 */

const schoolRepo = require('../repositories/school.repository');
const { SCHOOL_ROLES } = require('../models/school.model');
const logger = require('../../../utils/logger');

/* ──────────────────────────────────────────────────────────────
 * Shared helpers
 * ────────────────────────────────────────────────────────────── */
function fail(res, statusCode, message, code) {
  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code,
    },
  });
}

function getAuthenticatedUserId(req) {
  return req?.user?.id || req?.user?.uid || null;
}

function isPlatformAdmin(req) {
  return req?.user?.admin === true;
}

function getSchoolId(req) {
  return req?.params?.schoolId || null;
}

async function resolveSchoolRole(req) {
  const schoolId = getSchoolId(req);
  const userId = getAuthenticatedUserId(req);

  if (!schoolId) {
    return {
      error: {
        statusCode: 400,
        message: 'schoolId path parameter is required.',
        code: 'MISSING_SCHOOL_ID',
      },
    };
  }

  if (!userId) {
    return {
      error: {
        statusCode: 401,
        message: 'Unauthorized.',
        code: 'UNAUTHORIZED',
      },
    };
  }

  const role = await schoolRepo.getMemberRole(schoolId, userId);

  return {
    schoolId,
    userId,
    role,
  };
}

/* ──────────────────────────────────────────────────────────────
 * requireSchoolMember
 * Allows: school_admin, counselor
 * ────────────────────────────────────────────────────────────── */
async function requireSchoolMember(req, res, next) {
  try {
    if (isPlatformAdmin(req)) {
      req.schoolRole = SCHOOL_ROLES.ADMIN;
      return next();
    }

    const result = await resolveSchoolRole(req);

    if (result.error) {
      return fail(
        res,
        result.error.statusCode,
        result.error.message,
        result.error.code
      );
    }

    const { schoolId, userId, role } = result;

    if (!role) {
      logger.warn(
        { userId, schoolId },
        '[SchoolMiddleware] Access denied — not a school member'
      );

      return fail(
        res,
        403,
        'You are not a member of this school.',
        'NOT_SCHOOL_MEMBER'
      );
    }

    req.schoolRole = role;
    return next();
  } catch (err) {
    logger.error(
      {
        err: err?.message,
        stack: err?.stack,
      },
      '[SchoolMiddleware] requireSchoolMember error'
    );

    return next(err);
  }
}

/* ──────────────────────────────────────────────────────────────
 * requireSchoolAdmin
 * Allows: school_admin only
 * ────────────────────────────────────────────────────────────── */
async function requireSchoolAdmin(req, res, next) {
  try {
    if (isPlatformAdmin(req)) {
      req.schoolRole = SCHOOL_ROLES.ADMIN;
      return next();
    }

    const result = await resolveSchoolRole(req);

    if (result.error) {
      return fail(
        res,
        result.error.statusCode,
        result.error.message,
        result.error.code
      );
    }

    const { schoolId, userId, role } = result;

    if (role !== SCHOOL_ROLES.ADMIN) {
      logger.warn(
        { userId, schoolId, role },
        '[SchoolMiddleware] Access denied — school_admin required'
      );

      return fail(
        res,
        403,
        'Only school administrators can perform this action.',
        'SCHOOL_ADMIN_REQUIRED'
      );
    }

    req.schoolRole = role;
    return next();
  } catch (err) {
    logger.error(
      {
        err: err?.message,
        stack: err?.stack,
      },
      '[SchoolMiddleware] requireSchoolAdmin error'
    );

    return next(err);
  }
}

module.exports = {
  requireSchoolMember,
  requireSchoolAdmin,
};