'use strict';

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

/**
 * Validates and sanitizes projection query parameters
 *
 * Expected query params:
 *  - userId (optional)
 *  - targetRoleId (required)
 *  - years (optional, default 5, max 20)
 *  - currentExperienceYears (optional, default 0)
 */
exports.validateProjectionQuery = (query = {}) => {

  const {
    userId,
    targetRoleId,
    years,
    currentExperienceYears
  } = query;

  // 1️⃣ Required field validation
  if (!targetRoleId || typeof targetRoleId !== 'string') {
    throw new AppError(
      'targetRoleId is required and must be a string',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // 2️⃣ Years validation (default 5, max 20)
  let parsedYears = parseInt(years, 10);

  if (isNaN(parsedYears) || parsedYears <= 0) {
    parsedYears = 5;
  }

  if (parsedYears > 20) {
    parsedYears = 20;
  }

  // 3️⃣ Experience validation (default 0)
  let parsedExperience = parseFloat(currentExperienceYears);

  if (isNaN(parsedExperience) || parsedExperience < 0) {
    parsedExperience = 0;
  }

  // 4️⃣ Return sanitized object
  return {
    userId: userId || null,
    targetRoleId: targetRoleId.trim(),
    years: parsedYears,
    currentExperienceYears: parsedExperience,
  };
};
