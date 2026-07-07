'use strict';

/**
 * modules/knowledge-runtime/validation/validation.controller.js
 *
 * Same shape as knowledge.controller.js / studentIntelligence.controller.js /
 * recommendation.controller.js: validate -> delegate to service (via the
 * knowledge-runtime module singleton) -> { success, data } envelope ->
 * next(err) on failure.
 *
 * Self-scoped only, matching recommendation.controller.js's /me precedent —
 * validation is run for the authenticated caller (req.user.id), never a
 * client-supplied id. Objective 7 asked only for GET /me; no admin/
 * arbitrary-userId route is exposed here.
 */

const logger = require('../../../utils/logger');
const { getValidationService } = require('../knowledge-runtime.module');
const { validateUserId } = require('./validation.validator');
// WP-XAI2-02 (Response Contract Governance): canonical shared envelope
// helper, replacing a locally duplicated `sendSuccess`. Additive only.
const { sendSuccess } = require('../../../shared/response');

// WP-XAI2-03 (Enterprise Controller Security Audit): extends WP-SEC-01's
// review methodology to this controller. `ValidationService.
// validateDecisionReadiness()` returns `userId` at the top level of its
// (frozen) response object; the caller already knows their own id
// (self-scoped `/me` endpoint), but per WP-SEC-01 precedent this is
// closed the same way, at the controller boundary — `ValidationService`
// itself is unmodified.
function _toPublicValidation(result) {
  const { userId, ...publicResult } = result;
  return publicResult;
}

async function getMyValidation(req, res, next) {
  try {
    const userId = validateUserId(req.user?.id);

    const service = getValidationService();
    const result = await service.validateDecisionReadiness(userId);

    return sendSuccess(res, _toPublicValidation(result));
  } catch (err) {
    logger.error('[ValidationController.getMyValidation]', { error: err.message });
    return next(err);
  }
}

module.exports = Object.freeze({
  getMyValidation,
});
