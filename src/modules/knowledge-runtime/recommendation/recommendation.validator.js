'use strict';

/**
 * modules/knowledge-runtime/recommendation/recommendation.validator.js
 *
 * Same pattern as knowledge.validator.js / studentIntelligence.validator.js.
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const VALID_GROUPS = Object.freeze([
  'career',
  'programme',
  'course',
  'scholarship',
  'skill',
  'institution',
  'futureSkill',
  'occupation',
]);

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
 * @param {string[]|undefined} groups
 * @returns {string[]|null} validated group list, or null meaning "all groups"
 */
function validateGroups(groups) {
  if (groups === undefined || groups === null) return null;

  if (!Array.isArray(groups) || groups.length === 0) {
    _fail('groups must be a non-empty array when provided', { groups });
  }

  const invalid = groups.filter((g) => !VALID_GROUPS.includes(g));
  if (invalid.length) {
    _fail(`groups contains invalid values: ${invalid.join(', ')}`, {
      invalid,
      validGroups: VALID_GROUPS,
    });
  }

  return groups;
}

module.exports = {
  validateUserId,
  validateGroups,
  VALID_GROUPS,
};
