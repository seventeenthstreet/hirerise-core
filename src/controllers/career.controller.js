'use strict';

/**
 * career.controller.js — Career Path + JD Matching Controller
 *
 * ✅ Firebase completely removed (no dependencies)
 * ✅ Supabase-ready (service layer can use Supabase)
 * ✅ Async-safe with asyncHandler
 * ✅ Input validation added
 * ✅ Production-grade logging + error safety
 */

const { asyncHandler } = require('../utils/helpers');

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
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'currentRoleId is required',
    });
  }

  const result = await careerPathService.getCareerPath(currentRoleId);

  res.status(200).json({
    success: true,
    data: result,
  });
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
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'currentRoleId is required',
    });
  }

  const result = await careerPathService.getCareerPath(currentRoleId, {
    skills: Array.isArray(userSkills) ? userSkills : [],
    filters,
  });

  res.status(200).json({
    success: true,
    data: result,
    meta: {
      skillsIncludedInAnalysis: userSkills.length,
      requestedAt: new Date().toISOString(),
    },
  });
});

/**
 * @route   POST /career/match-jd
 * @desc    Match user profile with job description
 */
const matchJobDescription = asyncHandler(async (req, res) => {
  const { userProfile, rawJobDescription } = req.body || {};

  if (!userProfile || !rawJobDescription) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'userProfile and rawJobDescription are required',
    });
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
    userProfile: {
      ...userProfile,
      skills: normalizedSkills,
    },
    rawJobDescription,
  });

  res.status(200).json({
    success: true,
    data: result,
    meta: {
      jdCharacterCount: rawJobDescription.length,
      requestedAt: new Date().toISOString(),
    },
  });
});

module.exports = {
  getCareerPaths,
  getCareerPathsWithGap,
  matchJobDescription,
};