'use strict';

/**
 * modules/knowledge-runtime/decision/decision.validator.js
 *
 * Same pattern as knowledge.validator.js / studentIntelligence.validator.js /
 * recommendation.validator.js / validation.validator.js.
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

// Matches recommendation.validator.js's VALID_GROUPS exactly — see
// decision.service.js's KNOWN_DECISION_TYPES header comment for why these
// two lists must stay identical.
const VALID_DECISION_TYPES = Object.freeze([
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
 * @param {string} decisionType
 * @returns {string}
 */
function validateDecisionType(decisionType) {
  if (typeof decisionType !== 'string' || !decisionType.trim()) {
    _fail('decisionType is required and must be a non-empty string', { decisionType });
  }

  const trimmed = decisionType.trim();

  if (!VALID_DECISION_TYPES.includes(trimmed)) {
    _fail(`decisionType must be one of: ${VALID_DECISION_TYPES.join(', ')}`, {
      decisionType: trimmed,
      validDecisionTypes: VALID_DECISION_TYPES,
    });
  }

  return trimmed;
}

module.exports = {
  validateUserId,
  validateDecisionType,
  VALID_DECISION_TYPES,
};
