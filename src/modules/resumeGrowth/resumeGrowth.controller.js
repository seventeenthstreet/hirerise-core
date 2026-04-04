'use strict';

/**
 * src/modules/resumeGrowth/resumeGrowth.controller.js
 *
 * Production-ready controller
 * ----------------------------------------
 * Supabase-aligned clean controller layer.
 *
 * Improvements:
 * - No Firebase assumptions remain
 * - Strong request validation
 * - Safer null/type guards
 * - Cleaner async flow
 * - Consistent centralized error handling
 * - Singleton dependency construction
 * - Improved readability + maintainability
 * - Stable API response contract preserved
 */

const ResumeGrowthService = require('./resumeGrowth.service');
const ResumeGrowthRepository = require('./resumeGrowth.repository');
const RoleRepository = require('./role.repository');
const skillRepository = require('../../repositories/skillRepository');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

/**
 * Singleton dependency graph
 * Prevents unnecessary per-request object construction.
 */
const dependencies = Object.freeze({
  roleRepository: new RoleRepository(),
  skillRepository: new skillRepository(),
  resumeGrowthRepository: new ResumeGrowthRepository(),
});

const resumeGrowthService = new ResumeGrowthService(dependencies);

/**
 * Extract authenticated user id safely.
 * Supports Supabase auth middleware normalized user object.
 */
function getAuthenticatedUserId(req) {
  const userId = req?.user?.uid || req?.user?.id;

  if (!userId || typeof userId !== 'string') {
    throw new AppError(
      'Authenticated user not found',
      401,
      { field: 'user' },
      ErrorCodes.UNAUTHORIZED || 'UNAUTHORIZED'
    );
  }

  return userId;
}

/**
 * Normalize resume payload to preserve service expectations.
 * Converts Firestore-style optional undefined trees into safe row-ready objects.
 */
function sanitizeResumePayload(resume) {
  return {
    skills: Array.isArray(resume?.skills) ? resume.skills : [],
    experience: Array.isArray(resume?.experience) ? resume.experience : [],
    education: Array.isArray(resume?.education) ? resume.education : [],
    certifications: Array.isArray(resume?.certifications)
      ? resume.certifications
      : [],
    total_experience_years:
      typeof resume?.total_experience_years === 'number'
        ? resume.total_experience_years
        : null,
  };
}

/**
 * POST /api/v1/resume-growth/analyze
 */
exports.analyze = async (req, res, next) => {
  try {
    const { roleId, resume, persist } = req.body || {};

    if (!roleId || typeof roleId !== 'string') {
      return next(
        new AppError(
          'roleId is required and must be a string',
          400,
          { field: 'roleId' },
          ErrorCodes.VALIDATION_ERROR
        )
      );
    }

    if (!resume || typeof resume !== 'object' || Array.isArray(resume)) {
      return next(
        new AppError(
          'resume object is required',
          400,
          { field: 'resume' },
          ErrorCodes.VALIDATION_ERROR
        )
      );
    }

    const userId = getAuthenticatedUserId(req);
    const sanitizedResume = sanitizeResumePayload(resume);

    const result = await resumeGrowthService.analyze({
      user_id: userId,
      roleId,
      resume: sanitizedResume,
      persist: persist !== false,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * GET /api/v1/resume-growth/latest/:roleId
 */
exports.getLatest = async (req, res, next) => {
  try {
    const { roleId } = req.params || {};

    if (!roleId || typeof roleId !== 'string') {
      return next(
        new AppError(
          'roleId param is required',
          400,
          { field: 'roleId' },
          ErrorCodes.VALIDATION_ERROR
        )
      );
    }

    const userId = getAuthenticatedUserId(req);

    const result = await resumeGrowthService.getLatest(userId, roleId);

    if (!result) {
      return next(
        new AppError(
          'No growth signal found for this role',
          404,
          { roleId },
          ErrorCodes.NOT_FOUND
        )
      );
    }

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};