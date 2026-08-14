'use strict';

/**
 * @file src/domain/permission/evaluation/permission.evaluation.engine.js
 *
 * WP-ADMIN-04F-05 — Authorization Evaluation Engine
 *
 * Produces deterministic Authorization Decisions (AUTH-03 §4: Allow /
 * Deny) for a given Permission Identity + Authorization Context. Consumes
 * the certified Permission Registry (WP-ADMIN-04F-03) as its sole read
 * dependency, per this WP's architectural clarification — the Registry
 * already owns Permission discovery, identity resolution, and Lifecycle
 * Visibility, so there is no governance-specific capability this Engine
 * needs that the Registry does not already expose. The Governance
 * Service (WP-ADMIN-04F-04) is therefore never called on the evaluation
 * read path; nothing in this file imports it.
 *
 * Dependency direction: Evaluation -> Registry -> Repository -> Database.
 * This module performs no persistence, exposes no API, implements no
 * middleware and no UI, and never bypasses the Registry.
 *
 * Reuses the certified Domain layer exactly as-is (../permission.model.js):
 *   - `buildPermissionName()` to resolve a Permission Identity from a
 *     Resource + Action pair
 *   - `createAuthorizationContext()` for the Authorization Context shape
 *   - `createAuthorizationDecision()` for the Authorization Decision
 *     shape — no second decision model is introduced anywhere below.
 *
 * ── Evaluation Policy (architectural refinement) ────────────────────────
 * The lifecycle evaluability matrix (which statuses are evaluable at
 * all, and which Allow/Deny outcome a governed status produces) is
 * IMPLEMENTATION POLICY, not certified architecture — see this WP's
 * "Architectural Justification — Evaluability Matrix" review. It has
 * been extracted to `./permission.evaluation.policy.js` so this Engine
 * consumes a policy rather than hardcoding lifecycle status decisions.
 * The Engine itself knows nothing about what any particular status
 * means — it only asks its policy `isEvaluable(status)` and
 * `decide(entry)`. The policy remains internal to the Evaluation layer:
 * constructor-injectable like every other upstream dependency in this
 * domain, with no configuration surface, persistence, API, or UI.
 */

const { permissionRegistry: defaultRegistry } = require('../registry/permission.registry');
const { PERMISSION_STATUS } = require('../permission.constants');
const { buildPermissionName, createAuthorizationContext, createAuthorizationDecision } = require('../permission.model');
const { PermissionNotFoundError, PermissionNotEvaluableError } = require('./permission.evaluation.errors');
const { validateEvaluationRequestShape, validateNoDuplicateRequests } = require('./permission.evaluation.validation');
const { defaultEvaluationPolicy } = require('./permission.evaluation.policy');

/**
 * @typedef {Object} EvaluationExplanation
 * @property {string} permission - the Permission Identity evaluated
 * @property {string} resource
 * @property {string} action
 * @property {import('../permission.types').AuthorizationDecisionOutcome} decision
 * @property {string} reason
 * @property {Object} metadata - supporting diagnostic detail; never persisted
 */

/**
 * @typedef {Object} EvaluationResult
 * @property {import('../permission.types').AuthorizationDecision} decision
 * @property {EvaluationExplanation} explanation
 */

class AuthorizationEvaluationEngine {
  /**
   * @param {import('../registry/permission.registry').PermissionRegistry} [registry]
   *   Defaults to the shared PermissionRegistry singleton
   *   (../registry/permission.registry.js). Constructor-injectable for
   *   testing with a fake Registry, mirroring
   *   ../governance/permission.governance.service.js's own DI convention.
   * @param {import('./permission.evaluation.policy').EvaluationPolicy} [policy]
   *   Defaults to the shared `defaultEvaluationPolicy` singleton
   *   (./permission.evaluation.policy.js). Constructor-injectable for
   *   testing with an alternate policy, the same DI convention as
   *   `registry` above.
   */
  constructor(registry = defaultRegistry, policy = defaultEvaluationPolicy) {
    this._registry = registry;
    this._policy = policy;
  }

  /**
   * Resolves a Registry catalog entry for the identity built from an
   * already Domain-validated `resource:action` pair, or throws
   * `PermissionNotFoundError` (no entry exists at all — there is nothing
   * to evaluate, so this is never a Deny) or `PermissionNotEvaluableError`
   * (an entry exists but the policy reports its status is not
   * evaluable). Every evaluation starts here — the Engine never assumes
   * a Permission exists without a fresh Registry lookup.
   * @private
   */
  async _requireGovernedEntry(resource, action) {
    const identity = buildPermissionName(resource, action);
    const entry = await this._registry.getPermissionByIdentity(identity);
    if (!entry) {
      throw new PermissionNotFoundError(identity);
    }
    if (!this._policy.isEvaluable(entry.status)) {
      throw new PermissionNotEvaluableError(identity, entry.status);
    }
    return entry;
  }

  /**
   * Builds the structured, non-persisted Decision Explanation for a
   * decision already reached. Diagnostics/audit-visibility only. The
   * `deprecated` flag is diagnostic echo of `entry.status` (already
   * present in `metadata.permissionStatus`), not a policy decision — the
   * Allow/Deny outcome itself comes entirely from the injected policy.
   * @private
   */
  _explain(entry, decision) {
    return Object.freeze({
      permission: entry.identity,
      resource: entry.resource,
      action: entry.action,
      decision: decision.outcome,
      reason: decision.reason,
      metadata: Object.freeze({
        permissionStatus: entry.status,
        lifecycleStage: entry.lifecycleStage,
        category: entry.category,
        deprecated: entry.status === PERMISSION_STATUS.DEPRECATED,
      }),
    });
  }

  /**
   * Evaluates a single Authorization request and returns a deterministic
   * Allow/Deny `decision` (the certified Domain model, unmodified) plus
   * a structured, non-persisted `explanation`.
   *
   * @param {Object} request
   * @param {string} request.userId
   * @param {import('../permission.types').Resource} request.resource
   * @param {import('../permission.types').Action} request.action
   * @param {string} [request.resourceId]
   * @param {Object.<string, *>} [request.metadata]
   * @returns {Promise<EvaluationResult>}
   */
  async evaluate(request) {
    validateEvaluationRequestShape(request);

    const { userId, resource, action, resourceId = null, metadata = {} } = request;

    // Built through the certified Domain construction boundary first —
    // this is where an invalid Resource/Action enum value or a malformed
    // Context is caught (InvalidResourceError / InvalidActionError /
    // InvalidAuthorizationContextError from ../permission.errors.js),
    // before the Engine ever asks the Registry about an identity built
    // from unvalidated input.
    const context = createAuthorizationContext({ userId, resource, action, resourceId, metadata });

    const entry = await this._requireGovernedEntry(context.resource, context.action);

    const { outcome, reason } = this._policy.decide(entry);

    const decision = createAuthorizationDecision({ outcome, context, reason });
    const explanation = this._explain(entry, decision);

    return { decision, explanation };
  }

  /**
   * Evaluates a batch of Authorization requests. Rejects the whole batch
   * up front (before evaluating any request) if it contains duplicate
   * requests, per Evaluation Validation's "duplicate identities"
   * requirement — an ambiguous batch is an unsupported evaluation
   * request, not something to silently de-duplicate.
   *
   * @param {Array<Object>} requests
   * @returns {Promise<EvaluationResult[]>}
   */
  async evaluateBatch(requests) {
    validateNoDuplicateRequests(requests);
    const results = [];
    for (const request of requests) {
      // Sequential, not Promise.all: preserves the deterministic,
      // request-order-stable result list a caller reading `requests[i]`
      // against `results[i]` expects, and keeps failure attribution
      // (which request threw) unambiguous.
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.evaluate(request));
    }
    return results;
  }
}

module.exports = {
  AuthorizationEvaluationEngine,
  // Convenience singleton, matching this WP's own Registry/Governance
  // singleton convention.
  authorizationEvaluationEngine: new AuthorizationEvaluationEngine(),
};
