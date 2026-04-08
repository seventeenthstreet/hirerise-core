'use strict';

/**
 * src/modules/university/middleware/university.middleware.js
 *
 * Production-ready role guards for University Integration Layer
 * Fully Firebase-free
 * Supabase + JWT compatible
 */

const logger = require('../../../utils/logger');
const uniRepo = require('../repositories/university.repository');

// ─────────────────────────────────────────────────────────────
// Response Helpers
// ─────────────────────────────────────────────────────────────

function fail(res, statusCode, message, code) {
  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code,
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Auth Resolver
// Removes Firebase req.user.id dependency
// ─────────────────────────────────────────────────────────────

function getAuthenticatedUserId(req) {
  return (
    req.user?.id ||
    req.user?.uid || // temporary backward compatibility
    req.user?.user_id ||
    req.auth?.userId ||
    null
  );
}

// ─────────────────────────────────────────────────────────────
// Membership Loader
// Single DB hit pattern for maintainability
// ─────────────────────────────────────────────────────────────

async function loadMembership(req, universityId) {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    error.code = 'UNAUTHORIZED';
    throw error;
  }

  return uniRepo.getUniversityUser(universityId, userId);
}

// ─────────────────────────────────────────────────────────────
// Generic Role Guard Factory
// ─────────────────────────────────────────────────────────────

function requireUniversityRole(allowedRoles) {
  return async function universityRoleGuard(req, res, next) {
    try {
      const { universityId } = req.params;

      if (!universityId) {
        return fail(
          res,
          400,
          'University ID required.',
          'MISSING_UNIVERSITY_ID'
        );
      }

      const membership = await loadMembership(req, universityId);

      if (!membership) {
        return fail(
          res,
          403,
          'You are not a member of this university.',
          'UNIVERSITY_FORBIDDEN'
        );
      }

      if (
        Array.isArray(allowedRoles) &&
        allowedRoles.length > 0 &&
        !allowedRoles.includes(membership.role)
      ) {
        return fail(
          res,
          403,
          'Insufficient university permissions.',
          'UNIVERSITY_FORBIDDEN'
        );
      }

      req.universityMembership = membership;
      return next();

    } catch (err) {
      logger.error(
        {
          message: err.message,
          stack: err.stack,
          statusCode: err.statusCode,
        },
        '[UniversityMiddleware] role guard failure'
      );

      return fail(
        res,
        err.statusCode || 500,
        err.message || 'Internal server error',
        err.code || 'UNIVERSITY_MIDDLEWARE_ERROR'
      );
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Public Middleware Exports
// ─────────────────────────────────────────────────────────────

const requireUniversityMember = requireUniversityRole([
  'university_admin',
  'university_staff',
]);

const requireUniversityAdmin = requireUniversityRole([
  'university_admin',
]);

module.exports = {
  requireUniversityMember,
  requireUniversityAdmin,
};