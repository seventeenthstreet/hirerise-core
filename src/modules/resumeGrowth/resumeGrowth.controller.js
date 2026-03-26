'use strict';

/**
 * resumeGrowth.controller.js
 *
 * CHANGES (remediation sprint):
 *   FIX-4: Data isolation fix — replaced all hardcoded 'anonymous' userId literals
 *           with req.user.uid. Previously every user's analysis was stored and
 *           retrieved under the same shared 'anonymous' key, meaning User A could
 *           retrieve User B's last analysis result.
 *   FIX-9: Replaced inconsistent manual validation (if/else returning custom shapes)
 *           with proper next(new AppError(...)) calls so errors reach central errorHandler
 *           and return the standard { success, errorCode, message, details, timestamp } envelope.
 */

const ResumeGrowthService    = require('./resumeGrowth.service');
const ResumeGrowthRepository = require('./resumeGrowth.repository');
const RoleRepository         = require('../../repositories/RoleRepository');
const SkillRepository        = require('../../repositories/SkillRepository');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const roleRepository         = new RoleRepository();
const skillRepository        = new SkillRepository();
const resumeGrowthRepository = new ResumeGrowthRepository();

const resumeGrowthService = new ResumeGrowthService({
  roleRepository,
  skillRepository,
  resumeGrowthRepository,
});

/**
 * POST /api/v1/resume-growth/analyze
 */
exports.analyze = async (req, res, next) => {
  try {
    const { roleId, resume, persist } = req.body;

    // FIX-9: Use AppError + next() so errors reach central errorHandler
    if (!roleId || typeof roleId !== 'string') {
      return next(new AppError(
        'roleId is required and must be a string',
        400,
        { field: 'roleId' },
        ErrorCodes.VALIDATION_ERROR
      ));
    }

    if (!resume || typeof resume !== 'object' || Array.isArray(resume)) {
      return next(new AppError(
        'resume object is required',
        400,
        { field: 'resume' },
        ErrorCodes.VALIDATION_ERROR
      ));
    }

    const sanitizedResume = {
      skills:                  Array.isArray(resume.skills)         ? resume.skills         : [],
      experience:              Array.isArray(resume.experience)     ? resume.experience     : [],
      education:               Array.isArray(resume.education)      ? resume.education      : [],
      certifications:          Array.isArray(resume.certifications) ? resume.certifications : [],
      total_experience_years:  resume.total_experience_years,
    };

    const result = await resumeGrowthService.analyze({
      user_id: req.user.uid, // FIX-4: was hardcoded 'anonymous'
      roleId,
      resume: sanitizedResume,
      persist: persist !== false,
    });

    return res.status(200).json({ success: true, data: result });

  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/resume-growth/latest/:roleId
 */
exports.getLatest = async (req, res, next) => {
  try {
    const { roleId } = req.params;

    // FIX-9: Use AppError for consistent error envelope
    if (!roleId) {
      return next(new AppError(
        'roleId param is required',
        400,
        { field: 'roleId' },
        ErrorCodes.VALIDATION_ERROR
      ));
    }

    // FIX-4: was hardcoded 'anonymous' — users were seeing each other's data
    const result = await resumeGrowthService.getLatest(req.user.uid, roleId);

    if (!result) {
      return next(new AppError(
        'No growth signal found for this role',
        404,
        { roleId },
        ErrorCodes.NOT_FOUND
      ));
    }

    return res.status(200).json({ success: true, data: result });

  } catch (err) {
    next(err);
  }
};









