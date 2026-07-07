'use strict';

/**
 * modules/knowledge-runtime/validation/validation.validator.js
 *
 * Same pattern as knowledge.validator.js / studentIntelligence.validator.js /
 * recommendation.validator.js.
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

function _fail(message, meta = {}) {
  throw new AppError(message, 400, meta, ErrorCodes.VALIDATION_ERROR);
}

/**
 * @param {string} userId
 * @returns {string}
 */
function validateUserId(userId) {
  if (typeof userId !== 'string' || !userId.trim()) {
    _fail('userId is required and must be a non-empty string', { userId });
  }
  return userId.trim();
}

module.exports = {
  validateUserId,
};
