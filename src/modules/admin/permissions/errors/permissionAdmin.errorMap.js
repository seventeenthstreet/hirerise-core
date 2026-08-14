'use strict';

/**
 * @file src/modules/admin/permissions/errors/permissionAdmin.errorMap.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * This transport layer never invents its own domain error taxonomy — it
 * translates the named error classes already thrown by the certified
 * Registry (WP-ADMIN-04F-03), Assignment Service (WP-ADMIN-04F-06), and
 * Evaluation Engine (WP-ADMIN-04F-05) into the project's existing V2
 * canonical HTTP error envelope:
 *
 *   { success: false, error: { code, message }, meta: { requestId, timestamp } }
 *
 * — the same shape already produced by
 * `src/domain/permission/middleware/permission.middleware.js`,
 * `src/middleware/auth.middleware.js`, `src/middleware/requireAdmin.middleware.js`,
 * and `src/middleware/errorHandler.js`. No new response format is
 * introduced here.
 *
 * Only error *names* are matched (not `instanceof`, to avoid a second
 * import of every certified layer's error module here) — each certified
 * layer already assigns a stable `.name` to its thrown errors.
 */

const ERROR_STATUS_BY_NAME = Object.freeze({
  // Registry (src/domain/permission/registry/permission.registry.errors.js)
  PermissionRegistryValidationError: 400,
  DuplicatePermissionIdentityError: 409,
  MalformedRegistryEntryError: 422,

  // Assignment (src/domain/permission/assignment/permission.assignment.errors.js)
  InvalidAssignmentError: 400,
  PermissionNotAssignableError: 422,
  DuplicateAssignmentError: 409,
  AssignmentNotFoundError: 404,

  // Evaluation (src/domain/permission/evaluation/permission.evaluation.errors.js)
  PermissionNotFoundError: 404,
  PermissionNotEvaluableError: 422,
  AuthorizationContextError: 400,
  UnsupportedEvaluationError: 400,

  // Governance (src/domain/permission/governance/permission.governance.errors.js)
  // — WP-ADMIN-05C.
  InvalidLifecycleTransitionError: 422,
  PermissionAlreadyPublishedError: 409,
  PermissionAlreadyRetiredError: 409,
  GovernanceValidationError: 400,
  GovernanceConflictError: 409,

  // Domain-layer construction errors (src/domain/permission/permission.errors.js),
  // surfaced whenever a controller passes raw request input through a
  // certified factory (e.g. Evaluation's createAuthorizationContext()).
  InvalidResourceError: 400,
  InvalidActionError: 400,
  InvalidPermissionCategoryError: 400,
  InvalidPermissionStatusError: 400,
  InvalidAuthorizationContextError: 400,
  InvalidPermissionError: 400,
});

/**
 * @param {Error} error
 * @returns {number|null} the HTTP status this error maps to, or null if
 *   this map has no entry for it (an unexpected error — the caller
 *   should forward it to the project's central error handler instead of
 *   answering here).
 */
function statusForDomainError(error) {
  return ERROR_STATUS_BY_NAME[error?.name] ?? null;
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 */
function sendCanonicalError(req, res, statusCode, code, message) {
  return res.status(statusCode).json({
    success: false,
    error: { code, message },
    meta: {
      requestId: req?.requestId ?? req?.correlationId ?? null,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Attempts to translate a known certified-layer domain error into a V2
 * canonical HTTP response. Returns `true` if it did (the caller should
 * not call `next(error)`), `false` if the error is not one this map
 * recognizes (the caller should forward it to the central error handler
 * via `next(error)` instead).
 *
 * @param {Error} error
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean}
 */
function translateDomainError(error, req, res) {
  const statusCode = statusForDomainError(error);
  if (statusCode === null) {
    return false;
  }
  const code = error?.code ?? error?.name ?? 'PERMISSION_ADMIN_ERROR';
  sendCanonicalError(req, res, statusCode, code, error?.message ?? 'Request failed.');
  return true;
}

module.exports = {
  statusForDomainError,
  sendCanonicalError,
  translateDomainError,
};
