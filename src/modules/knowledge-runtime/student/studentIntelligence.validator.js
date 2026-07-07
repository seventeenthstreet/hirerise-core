'use strict';

/**
 * modules/knowledge-runtime/student/studentIntelligence.validator.js
 *
 * Input validation for StudentService's public surface. Same pattern as
 * `knowledge.validator.js` (WP-IMP-02): throws AppError using the existing
 * (argument-order-swapped) BaseRepository calling convention for
 * consistency with the rest of the codebase — see
 * `documents/WP-IMP-02/IMPLEMENTATION_NOTES.md` for why that convention is
 * intentionally preserved rather than fixed locally.
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const MAX_HISTORY_LIMIT = 50;

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

/**
 * @param {{ limit?: number }} [options]
 * @returns {{ limit: number }}
 */
function validateHistoryOptions(options = {}) {
  const { limit = 10 } = options ?? {};

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    _fail(`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`, { limit });
  }

  return { limit };
}

module.exports = {
  validateUserId,
  validateHistoryOptions,
  MAX_HISTORY_LIMIT,
};
