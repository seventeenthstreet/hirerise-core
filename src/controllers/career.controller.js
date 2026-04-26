'use strict';

/**
 * career.controller.js — Career Path + JD Matching Controller
 *
 * ✅ Firebase completely removed (no dependencies)
 * ✅ Supabase-ready (service layer can use Supabase)
 * ✅ Async-safe with asyncHandler
 * ✅ Input validation added
 * ✅ Production-grade logging + error safety
 * ✅ Standardized response envelope (sendSuccess / sendError) — Phase 3
 */

const { asyncHandler } = require('../utils/helpers');
const { sendSuccess, sendError } = require('../shared/response');

const careerPathService = require('../services/careerPath.service');
const jdMatchingService = require('../services/jdMatching.service');
const logger = require('../utils/logger');

/**
 * @route   GET /career/:currentRoleId
 * @desc    Get career paths (no skill gap analysis)
 */
const getCareerPaths = asyncHandler(async (req, res) => {
  const { currentRoleId } = req.params;

  if (!currentRoleId) {
    // BEFORE: { success:false, errorCode:'INVALID_INPUT', message:'...' }
    // AFTER:  { success:false, error:'...', message:'...', code:'INVALID_INPUT', meta:{...} }
    // Old field `errorCode` preserved via extra spread for backward compat.
    return sendError(res, 400, 'currentRoleId is required', 'INVALID_INPUT', {
      errorCode: 'INVALID_INPUT',
    });
  }

  const result = await careerPathService.getCareerPath(currentRoleId);

  // BEFORE: { success:true, data:result }
  // AFTER:  { success:true, data:result, meta:{ timestamp, requestId } }
  return sendSuccess(res, result);
});

/**
 * @route   POST /career/path-with-gap
 * @desc    Get career paths with skill gap analysis
 */
const getCareerPathsWithGap = asyncHandler(async (req, res) => {
  const {
    currentRoleId,
    userSkills = [],
    filters = {},
  } = req.body || {};

  if (!currentRoleId) {
    return sendError(res, 400, 'currentRoleId is required', 'INVALID_INPUT', {
      errorCode: 'INVALID_INPUT',
    });
  }

  const result = await careerPathService.getCareerPath(currentRoleId, {
    skills: Array.isArray(userSkills) ? userSkills : [],
    filters,
  });

  // BEFORE: { success:true, data:result, meta:{ skillsIncludedInAnalysis, requestedAt } }
  // AFTER:  same data shape + meta gains timestamp + requestId (requestedAt preserved)
  return sendSuccess(res, result, {}, {
    skillsIncludedInAnalysis: Array.isArray(userSkills) ? userSkills.length : 0,
    // backward compat: old meta key kept
    requestedAt: new Date().toISOString(),
  });
});

/**
 * @route   POST /career/match-jd
 * @desc    Match user profile with job description
 */
const matchJobDescription = asyncHandler(async (req, res) => {
  const { userProfile, rawJobDescription } = req.body || {};

  if (!userProfile || !rawJobDescription) {
    return sendError(
      res, 400,
      'userProfile and rawJobDescription are required',
      'INVALID_INPUT',
      { errorCode: 'INVALID_INPUT' }
    );
  }

  const safeSkills = Array.isArray(userProfile.skills)
    ? userProfile.skills
    : [];

  logger.debug('[CareerController] matchJobDescription called', {
    jdLength: rawJobDescription?.length || 0,
    skillCount: safeSkills.length,
  });

  const normalizedSkills = safeSkills.map((s) =>
    typeof s === 'string' ? { name: s } : s
  );

  const result = await jdMatchingService.matchJD({
    userProfile: { ...userProfile, skills: normalizedSkills },
    rawJobDescription,
  });

  // BEFORE: { success:true, data:result, meta:{ jdCharacterCount, requestedAt } }
  // AFTER:  adds timestamp + requestId to meta; jdCharacterCount + requestedAt preserved
  return sendSuccess(res, result, {}, {
    jdCharacterCount: rawJobDescription.length,
    requestedAt: new Date().toISOString(),
  });
});

module.exports = {
  getCareerPaths,
  getCareerPathsWithGap,
  matchJobDescription,
};