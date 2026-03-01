/**
 * career.controller.js — Career Path + JD Matching Controller
 *
 * CHANGES (remediation sprint):
 *   FIX-9: Wrapped all async handlers with asyncHandler() from src/utils/helpers.js.
 *   FIX-11: Corrected service method name to match careerPath.service.js exports:
 *           - computeCareerPaths → getCareerPath
 *           The service signature is getCareerPath(roleId, userProfile?), so
 *           userSkills and filters are passed as part of the userProfile object.
 */

'use strict';

const { asyncHandler } = require('../utils/helpers');

const careerPathService = require('../services/careerPath.service');
const jdMatchingService = require('../services/jdMatching.service');
const logger            = require('../utils/logger');

const getCareerPaths = asyncHandler(async (req, res) => {
  const { currentRoleId } = req.params;
  const { types, maxHops } = req.query;

  // FIX-11: was careerPathService.computeCareerPaths (not a function)
  // getCareerPath(roleId, userProfile?) — no userProfile for this endpoint
  const result = careerPathService.getCareerPath(currentRoleId);

  res.status(200).json({ success: true, data: result });
});

const getCareerPathsWithGap = asyncHandler(async (req, res) => {
  const { currentRoleId, userSkills = [], filters = {} } = req.body;

  // FIX-11: was careerPathService.computeCareerPaths (not a function)
  // Pass userSkills as userProfile so readiness/time estimates are computed
  const result = careerPathService.getCareerPath(currentRoleId, {
    skills: userSkills,
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

const matchJobDescription = asyncHandler(async (req, res) => {
  const { userProfile, rawJobDescription } = req.body;

  logger.debug('[CareerController] matchJobDescription called', {
    jdLength:   rawJobDescription.length,
    skillCount: userProfile.skills.length,
  });

  const normalizedSkills = userProfile.skills.map(s =>
    typeof s === 'string' ? { name: s } : s
  );

  const result = await jdMatchingService.matchJD({
    userProfile: { ...userProfile, skills: normalizedSkills },
    rawJobDescription,
  });

  res.status(200).json({
    success: true,
    data: result,
    meta: {
      jdCharacterCount: rawJobDescription.length,
      requestedAt:      new Date().toISOString(),
    },
  });
});

module.exports = {
  getCareerPaths,
  getCareerPathsWithGap,
  matchJobDescription,
};