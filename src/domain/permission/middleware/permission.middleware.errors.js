'use strict';

/**
 * @file src/domain/permission/middleware/permission.middleware.errors.js
 *
 * WP-ADMIN-04F-07 — Enterprise Authorization Middleware
 *
 * Named error hierarchy for the Middleware boundary, following the same
 * per-layer convention already established by every other layer in this
 * domain (Domain, Repository, Registry, Governance, Evaluation,
 * Assignment). A Middleware-layer error is never a Domain shape problem,
 * never a persistence problem, never a Registry/Governance/Evaluation/
 * Assignment problem — those are reused as-is (see permission.middleware.js)
 * — it is specifically an Express-integration problem: the authenticated
 * user is missing, or the middleware itself was configured incorrectly.
 *
 * Only the three classes named in WP-ADMIN-04F-07's "Middleware Errors"
 * section are defined here. Evaluation/Assignment errors are consumed
 * and translated into HTTP responses by permission.middleware.js — they
 * are never re-wrapped as one of these.
 */

/**
 * Base class for every error this module throws. Never thrown directly
 * — always one of the named subclasses below. Carries `statusCode` so a
 * generic Express error handler (src/middleware/errorHandler.js) can
 * translate an instance straight into the project's canonical HTTP
 * error envelope without any Middleware-specific branching.
 */
class AuthorizationMiddlewareError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   * @param {number} [metadata.statusCode] - defaults to 500
   */
  constructor(message, code = 'AUTHORIZATION_MIDDLEWARE_ERROR', metadata = {}) {
    const { statusCode = 500, ...rest } = metadata;
    super(message);
    this.name = 'AuthorizationMiddlewareError';
    this.code = code;
    this.statusCode = statusCode;
    this.metadata = rest;
    Error.captureStackTrace?.(this, AuthorizationMiddlewareError);
  }
}

/**
 * Thrown when a protected request reaches the Authorization Middleware
 * without an authenticated `req.user` (or without a resolvable user
 * identifier on it). Authentication itself is never performed here —
 * this only guards the Middleware's own precondition that Authentication
 * (and AdminGuard, where applicable) has already run.
 */
class MissingAuthenticatedUserError extends AuthorizationMiddlewareError {
  /**
   * @param {object} [metadata]
   */
  constructor(metadata = {}) {
    super('Authentication required.', 'UNAUTHORIZED', { statusCode: 401, ...metadata });
    this.name = 'MissingAuthenticatedUserError';
    Error.captureStackTrace?.(this, MissingAuthenticatedUserError);
  }
}

/**
 * Thrown synchronously by `requirePermission()` at route-registration
 * time (never per-request) when it is called with a malformed
 * configuration — a missing/invalid `resource`, a missing/invalid
 * `action`, or any other setup-time misuse. This is a programming error
 * in how the middleware factory was invoked, not a request-time
 * authorization outcome, so it is never sent as an HTTP response.
 */
class AuthorizationConfigurationError extends AuthorizationMiddlewareError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[AuthorizationMiddleware] ${message}`, 'AUTHORIZATION_CONFIGURATION_ERROR', {
      statusCode: 500,
      ...metadata,
    });
    this.name = 'AuthorizationConfigurationError';
    Error.captureStackTrace?.(this, AuthorizationConfigurationError);
  }
}

module.exports = {
  AuthorizationMiddlewareError,
  MissingAuthenticatedUserError,
  AuthorizationConfigurationError,
};
