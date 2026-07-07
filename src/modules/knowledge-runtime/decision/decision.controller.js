'use strict';

/**
 * modules/knowledge-runtime/decision/decision.controller.js
 *
 * Same shape as knowledge.controller.js / studentIntelligence.controller.js /
 * recommendation.controller.js / validation.controller.js: validate ->
 * delegate to service (via the knowledge-runtime module singleton) ->
 * { success, data } envelope -> next(err) on failure.
 *
 * Self-scoped only, matching validation.controller.js's /me precedent —
 * decisions are computed for the authenticated caller (req.user.id), never
 * a client-supplied id.
 *
 * WP-IMP-06 (Explainability Runtime, Stage 3): after the Decision is
 * computed, it is passed synchronously into `ExplainabilityRuntime.explain()`
 * and the resulting ExplanationPayload is attached to the response as
 * `data.explanation`.
 *
 * WP-SEC-01 (Decision API Response Exposure Review, Stage 3): the internal
 * Decision object returned by `DecisionEngine.decide()` is no longer
 * spread directly into the HTTP response. `_toPublicDecision()` below
 * defines the response-boundary filter approved by that review:
 *   - `userId` is dropped entirely (never part of `DECISION_OUTPUT_CONTRACT.md`,
 *     redundant on a self-scoped `/me` endpoint, and still fully available
 *     server-side via logging for any audit need).
 *   - `decisionFactors[].ruleId` is replaced with `.label`, reusing
 *     `ExplainabilityRuntime.RULE_LABELS` (the same static mapping already
 *     used for `explanation.factors[]`) rather than inventing a second one.
 *   - `reasoningTrace` is reshaped to strip the embedded `userId` prefix
 *     from each ref, preserving the field's documented purpose (a
 *     reference to the upstream trace) without re-exposing the caller's id.
 * Every other field is passed through unchanged. This is a response-layer
 * change only — `decision.service.js`'s internal object shape,
 * `explainability.service.js`, and the response envelope/auth/middleware
 * ordering are all untouched.
 */

const logger = require('../../../utils/logger');
const { getDecisionService, getExplainabilityService } = require('../knowledge-runtime.module');
const { validateUserId, validateDecisionType } = require('./decision.validator');
const { RULE_LABELS, UNKNOWN_RULE_LABEL } = require('../explainability/explainability.service');
// WP-XAI2-02 (Response Contract Governance): use the repository's single
// canonical response envelope helper instead of a locally duplicated
// `sendSuccess`. Additive only — `success`/`data` are unchanged; `meta`
// (timestamp/requestId) is now present, same as every other module already
// migrated to this helper (see `src/shared/response/index.js` header).
const { sendSuccess } = require('../../../shared/response');

/**
 * Strips a leading `${userId}:` prefix from a reasoningTrace ref string.
 * Refs are produced by `decision.service.js` `_reasoningTraceRefs()` as
 * `${userId}:${generatedAt}` — `generatedAt` is an ISO timestamp and may
 * itself contain colons, so the only safe way to remove the identifier is
 * to strip the exact known prefix rather than splitting on the first colon.
 * @private
 */
function _stripUserIdPrefix(ref, userId) {
  if (typeof ref !== 'string') return ref;
  const prefix = `${userId}:`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/** @private */
function _reshapeReasoningTrace(reasoningTrace, userId) {
  if (!reasoningTrace || typeof reasoningTrace !== 'object') return reasoningTrace;

  const reshaped = {};
  for (const [key, value] of Object.entries(reasoningTrace)) {
    reshaped[key] = _stripUserIdPrefix(value, userId);
  }
  return reshaped;
}

/**
 * Replaces each factor's raw `ruleId` with the equivalent human-readable
 * `label`, reusing `ExplainabilityRuntime.RULE_LABELS` verbatim (per
 * WP-SEC-01 Clarification Review §5 — no new mapping is introduced).
 * @private
 */
function _mapDecisionFactors(decisionFactors) {
  if (!Array.isArray(decisionFactors)) return decisionFactors;

  return decisionFactors.map((factor) => {
    if (!factor || typeof factor !== 'object') return factor;
    const { ruleId, ...rest } = factor;
    return { ...rest, label: RULE_LABELS[ruleId] ?? UNKNOWN_RULE_LABEL };
  });
}

/**
 * Builds the approved Public Decision API Contract response from the
 * internal Decision object. See module header for the field-by-field
 * rationale (WP-SEC-01 Implementation Clarification Review §2–§6).
 * @private
 */
function _toPublicDecision(decision, userId) {
  if (!decision || typeof decision !== 'object') return decision;

  const { userId: _internalUserId, decisionFactors, reasoningTrace, ...rest } = decision;
  void _internalUserId;

  return {
    ...rest,
    decisionFactors: _mapDecisionFactors(decisionFactors),
    reasoningTrace: _reshapeReasoningTrace(reasoningTrace, userId),
  };
}

async function decideMine(req, res, next) {
  try {
    const userId = validateUserId(req.user?.id);
    const decisionType = validateDecisionType(req.query?.decisionType);

    const decisionService = getDecisionService();
    const decision = await decisionService.decide(userId, decisionType);

    const explainabilityService = getExplainabilityService();
    const explanation = explainabilityService.explain(decision);

    const publicDecision = _toPublicDecision(decision, userId);

    return sendSuccess(res, { ...publicDecision, explanation });
  } catch (err) {
    logger.error('[DecisionController.decideMine]', { error: err.message });
    return next(err);
  }
}

module.exports = Object.freeze({
  decideMine,
});
