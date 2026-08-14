'use strict';

/**
 * @file src/domain/permission/evaluation/permission.evaluation.errors.js
 *
 * WP-ADMIN-04F-05 — Authorization Evaluation Engine
 *
 * Named error hierarchy for the Evaluation boundary, following the same
 * per-layer convention already established by the domain layer
 * (../permission.errors.js), the repository layer
 * (../repository/permission.repository.errors.js), the registry layer
 * (../registry/permission.registry.errors.js), and the governance layer
 * (../governance/permission.governance.errors.js). An Evaluation-layer
 * error is distinct from all four: it is never a domain shape problem
 * (guaranteed before a Permission/Context reaches Evaluation), never a
 * persistence problem (Evaluation has no direct database access), never a
 * catalog-wide consistency finding (that's Registry Validation), and
 * never a lifecycle-workflow problem (that's Governance) — it is
 * specifically an evaluation-request problem: a request that cannot be
 * evaluated as given, either because what it names does not exist or is
 * not currently evaluable, or because the request itself is malformed or
 * unsupported.
 */

class AuthorizationEvaluationError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'AuthorizationEvaluationError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, AuthorizationEvaluationError);
  }
}

/**
 * Thrown when the evaluation request itself does not resolve to a known
 * Permission Identity (`${resource}:${action}`) in the Registry catalog —
 * distinct from `PermissionNotEvaluableError`, which is for a Permission
 * that exists but cannot presently be evaluated.
 */
class PermissionNotFoundError extends AuthorizationEvaluationError {
  /**
   * @param {string} identity
   * @param {object} [metadata]
   */
  constructor(identity, metadata = {}) {
    super(
      `[Evaluation] no Permission found for identity "${identity}"`,
      'EVALUATION_PERMISSION_NOT_FOUND',
      { identity, ...metadata },
    );
    this.name = 'PermissionNotFoundError';
    Error.captureStackTrace?.(this, PermissionNotFoundError);
  }
}

/**
 * Thrown when a Permission exists in the Registry but has not completed
 * enough of the AUTH-04 §6 Governance Lifecycle to be evaluated — a
 * `proposed` or `approved` Permission has not yet been Published, so
 * asking "is this Allowed?" against it is a malformed evaluation request
 * rather than a real access decision (per AUTH-04 §8 "only governed
 * Permissions may be evaluated").
 */
class PermissionNotEvaluableError extends AuthorizationEvaluationError {
  /**
   * @param {string} identity
   * @param {string} status
   * @param {object} [metadata]
   */
  constructor(identity, status, metadata = {}) {
    super(
      `[Evaluation] Permission "${identity}" is not evaluable in its current status "${status}"`,
      'EVALUATION_PERMISSION_NOT_EVALUABLE',
      { identity, status, ...metadata },
    );
    this.name = 'PermissionNotEvaluableError';
    Error.captureStackTrace?.(this, PermissionNotEvaluableError);
  }
}

/**
 * Thrown when an Authorization Context supplied to the Evaluation Engine
 * is missing a required field or carries a mismatched Resource/Action
 * relative to the Permission Identity being evaluated. Distinct from the
 * Domain layer's `InvalidAuthorizationContextError` (malformed shape,
 * caught by `createAuthorizationContext()` itself) — this is for a
 * Context that is well-formed but evaluation-inconsistent.
 */
class AuthorizationContextError extends AuthorizationEvaluationError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Evaluation] ${message}`, 'EVALUATION_CONTEXT_ERROR', metadata);
    this.name = 'AuthorizationContextError';
    Error.captureStackTrace?.(this, AuthorizationContextError);
  }
}

/**
 * Thrown for an evaluation request the Engine does not support at all —
 * e.g. a non-object request, a batch containing duplicate identities, or
 * a request shape the Engine has no evaluation path for. This is a
 * request-support problem, distinct from a Context-consistency problem
 * (`AuthorizationContextError`) or a missing/unpublished Permission.
 */
class UnsupportedEvaluationError extends AuthorizationEvaluationError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Evaluation] ${message}`, 'EVALUATION_UNSUPPORTED_REQUEST', metadata);
    this.name = 'UnsupportedEvaluationError';
    Error.captureStackTrace?.(this, UnsupportedEvaluationError);
  }
}

module.exports = {
  AuthorizationEvaluationError,
  PermissionNotFoundError,
  PermissionNotEvaluableError,
  AuthorizationContextError,
  UnsupportedEvaluationError,
};
