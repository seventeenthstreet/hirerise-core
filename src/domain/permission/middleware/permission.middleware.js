'use strict';

/**
 * @file src/domain/permission/middleware/permission.middleware.js
 *
 * WP-ADMIN-04F-07 — Enterprise Authorization Middleware
 *
 * Express integration layer for the certified Authorization foundation.
 * Introduces no new authorization logic: every Allow/Deny outcome comes
 * from the certified Evaluation Engine (WP-ADMIN-04F-05) and Assignment
 * Service (WP-ADMIN-04F-06), consumed exactly as implemented.
 *
 * ── Request flow ─────────────────────────────────────────────────────
 *   Authenticated Request -> authenticate() (existing) -> AdminGuard
 *   (existing, where applicable) -> requirePermission(resource, action)
 *   -> Evaluation Engine -> Permission Grant Resolver -> Allow/Deny ->
 *   next() or an HTTP authorization response.
 *
 * ── Why both Evaluation and the Grant Resolver are consulted ────────
 * Evaluation answers a governance question — is this Permission
 * currently governed and in force at all (published/adopted/deprecated
 * vs. not-yet-published or retired)? It is not scoped to any one
 * Principal. The Grant Resolver answers a distinct, Principal-scoped
 * question — has *this* authenticated user actually been granted this
 * Permission, whether explicitly or via their Role? A request is only
 * allowed through when both hold:
 *
 *   1. `evaluationEngine.evaluate({ userId, resource, action })` must
 *      resolve to an Allow Decision. A thrown `PermissionNotFoundError`
 *      / `PermissionNotEvaluableError` (unknown or not-yet-governed
 *      Permission), or a resolved Deny Decision (e.g. a Retired
 *      Permission), both deny the request — the Decision's `outcome` is
 *      read here, not discarded, unlike the Assignment Service's own
 *      internal use of Evaluation (see
 *      ../assignment/permission.assignment.service.js's header for why
 *      that call site is different).
 *   2. `grantResolver.hasGrant({ principalId, role, resource, action })`
 *      must be `true`.
 *
 * ── WP-ADMIN-04F-10 — Role ↔ Permission Integration ─────────────────
 * Before WP-ADMIN-04F-10, step 2 above called
 * `assignmentService.hasAssignment()` directly, so this middleware
 * itself would have had to compose "explicit Assignment OR Role-derived
 * Permission" once Role-derivation was introduced. Per that WP's
 * approved architectural refinement, this middleware does not compose
 * those two responsibilities: `../resolver/permissionGrant.resolver.js`
 * owns that composition, and this module only calls its single
 * `hasGrant()`. The Assignment Service is not imported here — it
 * remains reachable only through the Grant Resolver. Request flow, and
 * the two-step Evaluate-then-grant-check shape above, are unchanged.
 *
 * All certified services are consumed via the Registry/Governance-
 * shielded surface they already expose; this module never imports the
 * Permission Repository, the Permission Registry, the Governance
 * Service, or (as of WP-ADMIN-04F-10) the Assignment Service directly.
 *
 * ── Middleware Validation ────────────────────────────────────────────
 * `requirePermission(resource, action)` validates its own configuration
 * synchronously, at call time (route registration), raising
 * `AuthorizationConfigurationError` for a malformed `resource`/`action`
 * — never at request time, and never as an HTTP response. Per-request,
 * the returned middleware validates that an authenticated user exists
 * on `req.user` before constructing an Authorization Context, and
 * otherwise reuses whatever Evaluation/Assignment errors are thrown
 * (evaluability, existence, malformed-context, and so on) rather than
 * duplicating that validation.
 */

const { authorizationEvaluationEngine: defaultEvaluationEngine } = require('../evaluation/permission.evaluation.engine');
const { permissionGrantResolver: defaultGrantResolver } = require('../resolver/permissionGrant.resolver');
const { AUTHORIZATION_DECISIONS, VALID_RESOURCES, VALID_ACTIONS } = require('../permission.constants');
const {
  AuthorizationMiddlewareError,
  MissingAuthenticatedUserError,
  AuthorizationConfigurationError,
} = require('./permission.middleware.errors');

// Evaluation/Assignment error names that represent a well-formed request
// naming a Permission that simply cannot be Allowed right now (unknown
// identity, not-yet-governed lifecycle status, or an evaluation-layer
// context inconsistency). Each is translated into an HTTP 403 Deny
// response carrying that error's own message as the reason — nothing
// here recreates *why* any of these deny; that determination was made
// entirely inside the certified Evaluation Engine. Any error name NOT
// in this set is treated as unexpected and passed to the project's
// central error handler instead (see `next(error)` below).
const DENIABLE_EVALUATION_ERROR_NAMES = new Set([
  'PermissionNotFoundError',
  'PermissionNotEvaluableError',
  'AuthorizationContextError',
  'UnsupportedEvaluationError',
]);

/**
 * Reuses the project's existing V2 canonical error envelope
 * (`{ success: false, error: { code, message }, meta: { requestId, timestamp } }`)
 * — the same shape `src/middleware/auth.middleware.js`,
 * `src/middleware/requireAdmin.middleware.js`, and
 * `src/middleware/errorHandler.js` already produce. No new response
 * format is introduced.
 * @private
 */
function sendAuthorizationResponse(req, res, statusCode, code, message) {
  return res.status(statusCode).json({
    success: false,
    error: { code, message },
    meta: {
      requestId: req?.requestId ?? null,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Resolves the authenticated user identifier from the existing,
 * upstream-populated `req.user` contract (`src/middleware/auth.middleware.js`).
 * Reuses `id`/`uid` exactly as that contract defines them — introduces
 * no additional identity model.
 * @private
 */
function resolveAuthenticatedUserId(req) {
  return req?.user?.id ?? req?.user?.uid ?? null;
}

/**
 * Resolves the authenticated user's existing, certified Role from the
 * same `req.user` contract, reusing exactly the lookup already used by
 * `src/middleware/requireAdminRoleClaim.middleware.js` (`req.user.role`
 * falling back to `req.user.customClaims.role`). Introduces no new
 * identity or Role model — this is read-only, purely to hand the
 * Principal's existing Role to the Grant Resolver (WP-ADMIN-04F-10);
 * this middleware never branches on the Role value itself.
 * @private
 */
function resolveAuthenticatedUserRole(req) {
  return req?.user?.role ?? req?.user?.customClaims?.role ?? null;
}

/**
 * Express middleware factory. Returns reusable Express middleware that
 * enforces the certified Authorization Decision for one
 * `resource`/`action` pair.
 *
 * @param {import('../permission.types').Resource} resource
 * @param {import('../permission.types').Action} action
 * @param {Object} [dependencies] - constructor-injection seam for tests;
 *   production call sites should omit this and get the shared certified
 *   singletons.
 * @param {import('../resolver/permissionGrant.resolver').PermissionGrantResolver} [dependencies.grantResolver]
 * @param {import('../evaluation/permission.evaluation.engine').AuthorizationEvaluationEngine} [dependencies.evaluationEngine]
 * @returns {import('express').RequestHandler}
 */
function requirePermission(resource, action, dependencies = {}) {
  if (typeof resource !== 'string' || !VALID_RESOURCES.includes(resource)) {
    throw new AuthorizationConfigurationError(
      `requirePermission() requires a valid Resource; received ${JSON.stringify(resource)}`,
      { resource },
    );
  }
  if (typeof action !== 'string' || !VALID_ACTIONS.includes(action)) {
    throw new AuthorizationConfigurationError(
      `requirePermission() requires a valid Action; received ${JSON.stringify(action)}`,
      { action },
    );
  }

  const grantResolver = dependencies.grantResolver ?? defaultGrantResolver;
  const evaluationEngine = dependencies.evaluationEngine ?? defaultEvaluationEngine;

  if (
    typeof grantResolver?.hasGrant !== 'function' ||
    typeof evaluationEngine?.evaluate !== 'function'
  ) {
    throw new AuthorizationConfigurationError(
      'requirePermission() requires a Permission Grant Resolver exposing hasGrant() and an Evaluation Engine exposing evaluate()',
    );
  }

  /**
   * @type {import('express').RequestHandler}
   */
  return async function authorizationMiddleware(req, res, next) {
    try {
      const userId = resolveAuthenticatedUserId(req);
      if (!req.user || !userId) {
        throw new MissingAuthenticatedUserError();
      }

      let evaluation;
      try {
        evaluation = await evaluationEngine.evaluate({ userId, resource, action });
      } catch (evaluationError) {
        if (DENIABLE_EVALUATION_ERROR_NAMES.has(evaluationError?.name)) {
          return sendAuthorizationResponse(req, res, 403, 'FORBIDDEN', evaluationError.message);
        }
        throw evaluationError;
      }

      if (evaluation.decision.outcome !== AUTHORIZATION_DECISIONS.ALLOW) {
        return sendAuthorizationResponse(
          req,
          res,
          403,
          'FORBIDDEN',
          evaluation.decision.reason ?? `Permission "${resource}:${action}" denied.`,
        );
      }

      const role = resolveAuthenticatedUserRole(req);
      const granted = await grantResolver.hasGrant({ principalId: userId, role, resource, action });
      if (!granted) {
        return sendAuthorizationResponse(
          req,
          res,
          403,
          'FORBIDDEN',
          `Principal lacks a Permission Grant for "${resource}:${action}".`,
        );
      }

      return next();
    } catch (error) {
      if (error instanceof MissingAuthenticatedUserError) {
        return sendAuthorizationResponse(req, res, error.statusCode, error.code, error.message);
      }

      // Unexpected failure (a genuine bug, a downstream outage, or a
      // malformed Context the certified Domain layer itself rejected) —
      // reuse the project's central error handler rather than
      // introducing a second response format here.
      return next(
        error instanceof AuthorizationMiddlewareError
          ? error
          : new AuthorizationMiddlewareError(error?.message ?? 'Authorization failed.', 'AUTHORIZATION_ERROR', {
              statusCode: 500,
              cause: error?.name,
            }),
      );
    }
  };
}

module.exports = Object.freeze({
  requirePermission,
});
