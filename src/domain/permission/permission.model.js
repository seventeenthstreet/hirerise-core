'use strict';

/**
 * @file src/domain/permission/permission.model.js
 *
 * WP-ADMIN-04F-01 — Permission Domain Foundation
 *
 * Domain model factories for Permission (AUTH-01 §3.2), Authorization
 * Context (AUTH-01 §3.8), and Authorization Decision (AUTH-01 §3.9;
 * AUTH-03 §4). Each factory validates its inputs via
 * `permission.validation.js` and returns a frozen, well-formed domain
 * object — this is the domain layer's construction boundary, so nothing
 * downstream ever has to re-derive a Permission's canonical name or
 * re-check enum membership.
 *
 * This module contains no persistence, no policy, and no evaluation
 * logic — `createAuthorizationDecision()` packages an outcome a future
 * evaluation component has already reached; it does not compute one.
 */

const { PERMISSION_STATUS } = require('./permission.constants');
const {
  validateResource,
  validateAction,
  validatePermissionCategory,
  validatePermissionStatus,
  validateAuthorizationDecisionOutcome,
  validateAuthorizationContext,
} = require('./permission.validation');
const { InvalidPermissionError } = require('./permission.errors');

/**
 * Builds a Permission's canonical, stable identifier (AUTH-04 §7 Stable
 * Permission Identity).
 *
 * @param {import('./permission.types').Resource} resource
 * @param {import('./permission.types').Action} action
 * @returns {string}
 */
function buildPermissionName(resource, action) {
  return `${resource}:${action}`;
}

/**
 * Constructs a well-formed, frozen Permission (AUTH-01 §3.2).
 *
 * A newly-proposed Permission that does not yet specify a status defaults
 * to `PROPOSED` (AUTH-04 §6 Governance Lifecycle's first stage) rather
 * than requiring every call site to name it explicitly.
 *
 * @param {Object} input
 * @param {import('./permission.types').Resource} input.resource
 * @param {import('./permission.types').Action} input.action
 * @param {import('./permission.types').PermissionCategory} [input.category]
 * @param {import('./permission.types').PermissionStatus} [input.status]
 * @param {string} [input.description]
 * @returns {import('./permission.types').Permission}
 */
function createPermission({ resource, action, category = null, status = PERMISSION_STATUS.PROPOSED, description = null } = {}) {
  validateResource(resource);
  validateAction(action);
  validatePermissionCategory(category);
  validatePermissionStatus(status);

  if (description !== null && typeof description !== 'string') {
    throw new InvalidPermissionError('description must be a string or null', { received: description });
  }

  return Object.freeze({
    name: buildPermissionName(resource, action),
    resource,
    action,
    category,
    status,
    description,
  });
}

/**
 * Constructs a well-formed, frozen Authorization Context (AUTH-01 §3.8).
 * Deliberately minimal, matching the certified architecture — `metadata`
 * is the seam future scope (organization, team) extends through.
 *
 * @param {Object} input
 * @param {string} input.userId
 * @param {import('./permission.types').Resource} input.resource
 * @param {import('./permission.types').Action} input.action
 * @param {string} [input.resourceId]
 * @param {Object.<string, *>} [input.metadata]
 * @returns {import('./permission.types').AuthorizationContext}
 */
function createAuthorizationContext({ userId, resource, action, resourceId = null, metadata = {} } = {}) {
  const context = Object.freeze({
    userId,
    resource,
    action,
    resourceId,
    metadata: Object.freeze({ ...metadata }),
  });

  validateAuthorizationContext(context);

  return context;
}

/**
 * Constructs a well-formed, frozen Authorization Decision (AUTH-01 §3.9;
 * AUTH-03 §4). This packages a decision a future evaluation component has
 * already reached — it does not evaluate anything itself.
 *
 * @param {Object} input
 * @param {import('./permission.types').AuthorizationDecisionOutcome} input.outcome
 * @param {import('./permission.types').AuthorizationContext} input.context
 * @param {string} [input.reason]
 * @param {Date|string} [input.decidedAt] - defaults to the current time
 * @returns {import('./permission.types').AuthorizationDecision}
 */
function createAuthorizationDecision({ outcome, context, reason = null, decidedAt = new Date() } = {}) {
  validateAuthorizationDecisionOutcome(outcome);
  validateAuthorizationContext(context);

  const decidedAtIso = decidedAt instanceof Date ? decidedAt.toISOString() : decidedAt;

  const decision = Object.freeze({
    outcome,
    context,
    reason,
    decidedAt: decidedAtIso,
  });

  return decision;
}

module.exports = {
  buildPermissionName,
  createPermission,
  createAuthorizationContext,
  createAuthorizationDecision,
};
