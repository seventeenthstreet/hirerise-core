'use strict';

/**
 * src/modules/jobMatchPremium/validators/jobMatchPremium.validator.js
 *
 * Input validation for WP-13B endpoints.
 * Pure validation — no DB calls, no business logic.
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/**
 * Validates POST /premium/match body.
 * Throws AppError(400) on invalid input.
 */
function validateMatchRequest(body) {
  const { resumeId } = body ?? {};

  if (!resumeId) {
    throw new AppError(
      'resumeId is required',
      400,
      { field: 'resumeId' },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (!isValidUuid(resumeId)) {
    throw new AppError(
      'resumeId must be a valid UUID',
      400,
      { field: 'resumeId', value: resumeId },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

/**
 * Validates GET /premium/match/:resumeId/latest params.
 * Throws AppError(400) on invalid input.
 */
function validateLatestRequest(params) {
  const { resumeId } = params ?? {};

  if (!resumeId || !isValidUuid(resumeId)) {
    throw new AppError(
      'resumeId path parameter must be a valid UUID',
      400,
      { field: 'resumeId' },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

module.exports = { validateMatchRequest, validateLatestRequest };
