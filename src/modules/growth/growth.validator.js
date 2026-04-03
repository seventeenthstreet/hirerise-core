'use strict';

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

/**
 * Projection query validation constraints
 */
const DEFAULT_YEARS = 5;
const MAX_YEARS = 20;
const DEFAULT_EXPERIENCE = 0;
const MAX_EXPERIENCE = 50;

/**
 * Safely parse bounded integer values.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

/**
 * Safely parse bounded float values.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseBoundedFloat(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

/**
 * Validates and sanitizes projection query parameters.
 *
 * Expected query params:
 *  - userId (optional)
 *  - targetRoleId (required)
 *  - years (optional, default 5, max 20)
 *  - currentExperienceYears (optional, default 0)
 *
 * @param {object} query
 * @returns {{
 *   userId: string|null,
 *   targetRoleId: string,
 *   years: number,
 *   currentExperienceYears: number
 * }}
 */
exports.validateProjectionQuery = (query = {}) => {
  const rawTargetRoleId =
    typeof query.targetRoleId === 'string'
      ? query.targetRoleId.trim()
      : '';

  /**
   * Required field validation
   */
  if (!rawTargetRoleId) {
    throw new AppError(
      'targetRoleId is required and must be a non-empty string',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const sanitizedYears = parseBoundedInt(
    query.years,
    DEFAULT_YEARS,
    1,
    MAX_YEARS
  );

  const sanitizedExperience = parseBoundedFloat(
    query.currentExperienceYears,
    DEFAULT_EXPERIENCE,
    0,
    MAX_EXPERIENCE
  );

  return {
    userId:
      typeof query.userId === 'string' && query.userId.trim()
        ? query.userId.trim()
        : null,
    targetRoleId: rawTargetRoleId,
    years: sanitizedYears,
    currentExperienceYears: sanitizedExperience
  };
};