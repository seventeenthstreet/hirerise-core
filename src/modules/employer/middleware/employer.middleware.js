'use strict';

/**
 * src/modules/employer/middleware/employer.middleware.js
 *
 * Employer authorization middleware
 * ---------------------------------
 * Role guards for Employer Integration Layer.
 *
 * Guards:
 * - requireEmployerMember → employer_admin | employer_hr
 * - requireEmployerAdmin  → employer_admin only
 *
 * Supabase migration:
 * - removed Firebase req.user.id dependency
 * - standardized authenticated user extraction
 * - improved async error flow
 * - added structured logging
 * - null-safe request handling
 */

const logger = require('../../../utils/logger');
const employerRepository = require('../repositories/employer.repository');

function fail(res, statusCode, message, code = 'EMPLOYER_FORBIDDEN') {
  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code,
    },
  });
}

/**
 * Extract authenticated user ID safely
 *
 * Supports:
 * - req.user.id  → Supabase standard
 * - req.user.id → legacy Firebase compatibility during migration
 */
function getAuthenticatedUserId(req) {
  return req?.user?.id || req?.user?.uid || null;
}

/**
 * Shared membership loader
 */
async function loadMembership(employerId, userId) {
  return employerRepository.getEmployerUser(employerId, userId);
}

/**
 * Require any employer membership
 */
async function requireEmployerMember(req, res, next) {
  const employerId = req?.params?.employerId;
  const userId = getAuthenticatedUserId(req);

  if (!employerId) {
    return fail(res, 400, 'Employer ID required.', 'MISSING_EMPLOYER_ID');
  }

  if (!userId) {
    return fail(res, 401, 'Unauthorized.', 'UNAUTHORIZED');
  }

  try {
    const membership = await loadMembership(employerId, userId);

    if (!membership) {
      return fail(
        res,
        403,
        'You are not a member of this employer organisation.',
        'EMPLOYER_FORBIDDEN'
      );
    }

    req.employerMembership = membership;
    return next();
  } catch (err) {
    logger.error(
      {
        employerId,
        userId,
        message: err?.message,
        stack: err?.stack,
      },
      '[EmployerMiddleware] requireEmployerMember'
    );

    return fail(res, err?.statusCode || 500, err?.message || 'Authorization failed.');
  }
}

/**
 * Require employer admin membership
 */
async function requireEmployerAdmin(req, res, next) {
  const employerId = req?.params?.employerId;
  const userId = getAuthenticatedUserId(req);

  if (!employerId) {
    return fail(res, 400, 'Employer ID required.', 'MISSING_EMPLOYER_ID');
  }

  if (!userId) {
    return fail(res, 401, 'Unauthorized.', 'UNAUTHORIZED');
  }

  try {
    const membership = await loadMembership(employerId, userId);

    if (!membership || membership.role !== 'employer_admin') {
      return fail(
        res,
        403,
        'Employer admin access required.',
        'EMPLOYER_ADMIN_REQUIRED'
      );
    }

    req.employerMembership = membership;
    return next();
  } catch (err) {
    logger.error(
      {
        employerId,
        userId,
        message: err?.message,
        stack: err?.stack,
      },
      '[EmployerMiddleware] requireEmployerAdmin'
    );

    return fail(res, err?.statusCode || 500, err?.message || 'Authorization failed.');
  }
}

module.exports = {
  requireEmployerMember,
  requireEmployerAdmin,
};