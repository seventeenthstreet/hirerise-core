'use strict';

/**
 * @file src/domain/permission/evaluation/permission.evaluation.validation.js
 *
 * WP-ADMIN-04F-05 — Authorization Evaluation Engine
 *
 * Evaluation-specific request validation only, per this WP's explicit
 * scope: missing Permission, invalid Resource, invalid Action, malformed
 * Authorization Context, duplicate identities (within a batch), and
 * unsupported evaluation requests. This module does NOT duplicate the
 * Domain layer's enum/shape validation (`../permission.validation.js`,
 * exercised via `createAuthorizationContext()`/`createPermission()`) —
 * it validates the *evaluation request* one layer up from that: is this
 * something the Engine can even attempt to evaluate, before the Domain
 * layer is asked to construct a Context from it.
 *
 * Every function below either returns without value (validation only,
 * caller already has what it needs) or throws one of the typed errors in
 * `./permission.evaluation.errors.js`. Nothing here performs lifecycle
 * validation (Governance's job) or catalog-wide consistency checks
 * (Registry's job).
 */

const { UnsupportedEvaluationError, AuthorizationContextError } = require('./permission.evaluation.errors');

/**
 * Validates the raw shape of a single evaluation request before it is
 * handed to `createAuthorizationContext()` — catches "not an object at
 * all" / "missing userId, resource, or action" up front with an
 * Evaluation-specific error, rather than letting an evaluation call fail
 * with a Domain-layer error that talks about Context construction, not
 * evaluation requests.
 *
 * @param {*} request
 */
function validateEvaluationRequestShape(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new UnsupportedEvaluationError('evaluation request must be a non-null object', {
      received: request === null ? 'null' : typeof request,
    });
  }

  const { userId, resource, action } = request;

  if (typeof userId !== 'string' || userId.length === 0) {
    throw new AuthorizationContextError('evaluation request requires a non-empty string "userId"', { received: userId });
  }
  if (typeof resource !== 'string' || resource.length === 0) {
    throw new AuthorizationContextError('evaluation request requires a non-empty string "resource"', { received: resource });
  }
  if (typeof action !== 'string' || action.length === 0) {
    throw new AuthorizationContextError('evaluation request requires a non-empty string "action"', { received: action });
  }
}

/**
 * Validates that a batch of evaluation requests contains no duplicate
 * identities — the same (userId, resource, action, resourceId) request
 * appearing more than once in a single batch is an unsupported
 * evaluation request (ambiguous which result the caller intends to rely
 * on), not silently de-duplicated.
 *
 * @param {Array<Object>} requests
 */
function validateNoDuplicateRequests(requests) {
  if (!Array.isArray(requests)) {
    throw new UnsupportedEvaluationError('evaluation batch must be an array of evaluation requests', {
      received: typeof requests,
    });
  }

  const seen = new Set();
  requests.forEach((request, index) => {
    validateEvaluationRequestShape(request);
    const key = `${request.userId}::${request.resource}:${request.action}::${request.resourceId ?? ''}`;
    if (seen.has(key)) {
      throw new UnsupportedEvaluationError(`duplicate evaluation request at index ${index}`, {
        index,
        userId: request.userId,
        resource: request.resource,
        action: request.action,
        resourceId: request.resourceId ?? null,
      });
    }
    seen.add(key);
  });
}

module.exports = {
  validateEvaluationRequestShape,
  validateNoDuplicateRequests,
};
