'use strict';

/**
 * middleware/school.middleware.js
 *
 * Role-based access control middleware for the School & Counselor Platform.
 *
 * Middlewares:
 *   requireSchoolMember  — user must be admin OR counselor in the school
 *   requireSchoolAdmin   — user must be school_admin in the school
 *
 * Both middlewares:
 *   1. Extract schoolId from req.params.schoolId
 *   2. Look up the user's role in sch_school_users
 *   3. Attach req.schoolRole for downstream use
 *   4. Return 403 if role is insufficient
 *
 * Usage:
 *   router.get('/students', requireSchoolMember, controller.listStudents);
 *   router.post('/counselors', requireSchoolAdmin, controller.addCounselor);
 */

const schoolRepo   = require('../repositories/school.repository');
const { SCHOOL_ROLES } = require('../models/school.model');
const logger           = require('../../../utils/logger');

// ─── requireSchoolMember ───────────────────────────────────────────────────────

/**
 * Allows school_admin and counselor.
 * Platform admins (req.user.admin === true) bypass this check.
 */
async function requireSchoolMember(req, res, next) {
  try {
    // Platform admins can access any school
    if (req.user && req.user.admin) {
      req.schoolRole = SCHOOL_ROLES.ADMIN;
      return next();
    }

    const schoolId = req.params.schoolId;
    const userId   = req.user && req.user.uid;

    if (!schoolId) {
      return res.status(400).json({
        success: false,
        error: { message: 'schoolId path parameter is required.', code: 'MISSING_SCHOOL_ID' },
      });
    }

    const role = await schoolRepo.getMemberRole(schoolId, userId);

    if (!role) {
      logger.warn({ userId, schoolId }, '[SchoolMiddleware] Access denied — not a school member');
      return res.status(403).json({
        success: false,
        error: { message: 'You are not a member of this school.', code: 'NOT_SCHOOL_MEMBER' },
      });
    }

    req.schoolRole = role;
    return next();
  } catch (err) {
    logger.error({ err: err.message }, '[SchoolMiddleware] requireSchoolMember error');
    return next(err);
  }
}

// ─── requireSchoolAdmin ────────────────────────────────────────────────────────

/**
 * Allows school_admin only.
 * Platform admins (req.user.admin === true) bypass this check.
 */
async function requireSchoolAdmin(req, res, next) {
  try {
    if (req.user && req.user.admin) {
      req.schoolRole = SCHOOL_ROLES.ADMIN;
      return next();
    }

    const schoolId = req.params.schoolId;
    const userId   = req.user && req.user.uid;

    if (!schoolId) {
      return res.status(400).json({
        success: false,
        error: { message: 'schoolId path parameter is required.', code: 'MISSING_SCHOOL_ID' },
      });
    }

    const role = await schoolRepo.getMemberRole(schoolId, userId);

    if (role !== SCHOOL_ROLES.ADMIN) {
      logger.warn({ userId, schoolId, role }, '[SchoolMiddleware] Access denied — school_admin required');
      return res.status(403).json({
        success: false,
        error: {
          message: 'Only school administrators can perform this action.',
          code:    'SCHOOL_ADMIN_REQUIRED',
        },
      });
    }

    req.schoolRole = role;
    return next();
  } catch (err) {
    logger.error({ err: err.message }, '[SchoolMiddleware] requireSchoolAdmin error');
    return next(err);
  }
}

module.exports = { requireSchoolMember, requireSchoolAdmin };









