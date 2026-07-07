'use strict';

/**
 * modules/knowledge-runtime/recommendation/recommendation.controller.js
 *
 * Same shape as knowledge.controller.js / studentIntelligence.controller.js:
 * validate → delegate to service (via the knowledge-runtime module
 * singleton) → { success, data } envelope → next(err) on failure.
 *
 * Self-scoped only in this WP — recommendations are generated for the
 * authenticated caller (req.user.id), never a client-supplied id, matching
 * the /me pattern established by studentIntelligence.controller.js. No
 * admin/arbitrary-userId route is exposed here; Objective 9 didn't ask for
 * one, and StudentService's own admin route was justified by an explicit
 * operational need (support/debugging another student's context) that
 * wasn't stated for recommendations.
 */

const logger = require('../../../utils/logger');
const { getRecommendationService } = require('../knowledge-runtime.module');
const { validateUserId, validateGroups } = require('./recommendation.validator');
// WP-XAI2-02 (Response Contract Governance): canonical shared envelope
// helper, replacing a locally duplicated `sendSuccess`. Additive only.
const { sendSuccess } = require('../../../shared/response');

// WP-XAI2-03 (Enterprise Controller Security Audit): extends WP-SEC-01's
// review methodology to this controller. `RecommendationService.
// generateRecommendationCandidates()` returns `userId` at the top level of
// its (frozen) response object; the caller already knows their own id
// (this is a self-scoped `/me` endpoint, `req.user.id`, never a
// client-supplied value), but per WP-SEC-01 precedent this is still the
// same class of undisciplined response boundary and is closed the same
// way: filtered here, at the controller, not by changing the service's
// internal object shape. `RecommendationService` itself is unmodified.
function _toPublicRecommendations(result) {
  const { userId, ...publicResult } = result;
  return publicResult;
}

async function getMyRecommendations(req, res, next) {
  try {
    const userId = validateUserId(req.user?.id);
    const groupsRaw = req.query.groups
      ? String(req.query.groups).split(',').map((g) => g.trim())
      : undefined;
    const groups = validateGroups(groupsRaw);

    const service = getRecommendationService();
    const result = await service.generateRecommendationCandidates(userId, { groups });

    return sendSuccess(res, _toPublicRecommendations(result));
  } catch (err) {
    logger.error('[RecommendationController.getMyRecommendations]', { error: err.message });
    return next(err);
  }
}

module.exports = Object.freeze({
  getMyRecommendations,
});
