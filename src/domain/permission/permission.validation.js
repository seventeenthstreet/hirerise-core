'use strict';

/**
 * @file src/domain/permission/permission.validation.js
 *
 * WP-ADMIN-04F-01 — Permission Domain Foundation
 *
 * Lightweight domain validation only, per WP-ADMIN-04F-01's explicit
 * scope: invalid enum values, malformed Permission objects, invalid
 * Resource/Action names. This module does NOT implement business
 * authorization rules, permission resolution, or evaluation logic — those
 * belong to later work packages (AUTH-03's Authorization Evaluation).
 *
 * Every function below either returns the validated value unchanged (so
 * callers can validate-and-use in one expression) or throws one of the
 * typed errors in `permission.errors.js`.
 */

const {
  VALID_RESOURCES,
  VALID_ACTIONS,
  VALID_PERMISSION_CATEGORIES,
  VALID_PERMISSION_STATUSES,
  VALID_AUTHORIZATION_DECISIONS,
} = require('./permission.constants');

const {
  InvalidResourceError,
  InvalidActionError,
  InvalidPermissionCategoryError,
  InvalidPermissionStatusError,
  InvalidPermissionError,
  InvalidAuthorizationContextError,
  InvalidAuthorizationDecisionError,
} = require('./permission.errors');

// ─────────────────────────────────────────────────────────────────────────
// Predicates — never throw, always return a boolean.
// ─────────────────────────────────────────────────────────────────────────

/** @param {*} value @returns {boolean} */
function isValidResource(value) {
  return typeof value === 'string' && VALID_RESOURCES.includes(value);
}

/** @param {*} value @returns {boolean} */
function isValidAction(value) {
  return typeof value === 'string' && VALID_ACTIONS.includes(value);
}

/** @param {*} value @returns {boolean} */
function isValidPermissionCategory(value) {
  return typeof value === 'string' && VALID_PERMISSION_CATEGORIES.includes(value);
}

/** @param {*} value @returns {boolean} */
function isValidPermissionStatus(value) {
  return typeof value === 'string' && VALID_PERMISSION_STATUSES.includes(value);
}

/** @param {*} value @returns {boolean} */
function isValidAuthorizationDecisionOutcome(value) {
  return typeof value === 'string' && VALID_AUTHORIZATION_DECISIONS.includes(value);
}

// ─────────────────────────────────────────────────────────────────────────
// Assertions — return the value on success, throw a typed error on
// failure.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {*} value
 * @returns {import('./permission.types').Resource}
 * @throws {InvalidResourceError}
 */
function validateResource(value) {
  if (!isValidResource(value)) {
    throw new InvalidResourceError(value);
  }
  return value;
}

/**
 * @param {*} value
 * @returns {import('./permission.types').Action}
 * @throws {InvalidActionError}
 */
function validateAction(value) {
  if (!isValidAction(value)) {
    throw new InvalidActionError(value);
  }
  return value;
}

/**
 * A Permission Category is optional (AUTH-01 §3.7) — `null` and
 * `undefined` are valid "no category" values and are normalized to
 * `null`. Any other non-matching value is invalid.
 *
 * @param {*} value
 * @returns {import('./permission.types').PermissionCategory|null}
 * @throws {InvalidPermissionCategoryError}
 */
function validatePermissionCategory(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isValidPermissionCategory(value)) {
    throw new InvalidPermissionCategoryError(value);
  }
  return value;
}

/**
 * @param {*} value
 * @returns {import('./permission.types').PermissionStatus}
 * @throws {InvalidPermissionStatusError}
 */
function validatePermissionStatus(value) {
  if (!isValidPermissionStatus(value)) {
    throw new InvalidPermissionStatusError(value);
  }
  return value;
}

/**
 * @param {*} value
 * @returns {import('./permission.types').AuthorizationDecisionOutcome}
 * @throws {InvalidAuthorizationDecisionError}
 */
function validateAuthorizationDecisionOutcome(value) {
  if (!isValidAuthorizationDecisionOutcome(value)) {
    throw new InvalidAuthorizationDecisionError(
      `outcome must be one of ${VALID_AUTHORIZATION_DECISIONS.join(', ')}, received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Validates the shape of a candidate Permission object (AUTH-01 §3.2).
 * Does not construct a Permission — see `permission.model.js`'s
 * `createPermission()` for that. This only asserts that an already-built
 * (or externally-supplied) object is well-formed.
 *
 * @param {*} permission
 * @returns {import('./permission.types').Permission}
 * @throws {InvalidPermissionError|InvalidResourceError|InvalidActionError|InvalidPermissionCategoryError|InvalidPermissionStatusError}
 */
function validatePermission(permission) {
  if (typeof permission !== 'object' || permission === null || Array.isArray(permission)) {
    throw new InvalidPermissionError('expected a Permission object', { received: permission });
  }

  const { name, resource, action, category = null, status, description = null } = permission;

  validateResource(resource);
  validateAction(action);
  validatePermissionCategory(category);
  validatePermissionStatus(status);

  if (typeof name !== 'string' || name.length === 0) {
    throw new InvalidPermissionError('name must be a non-empty string', { received: name });
  }

  const expectedName = `${resource}:${action}`;
  if (name !== expectedName) {
    throw new InvalidPermissionError(
      `name "${name}" does not match resource:action ("${expectedName}")`,
      { name, resource, action },
    );
  }

  if (description !== null && typeof description !== 'string') {
    throw new InvalidPermissionError('description must be a string or null', { received: description });
  }

  return permission;
}

/**
 * Validates the shape of a candidate Authorization Context object
 * (AUTH-01 §3.8). Deliberately minimal, matching AUTH-01 §3.8's
 * definition — only `userId`, `resource`, and `action` are required.
 *
 * @param {*} context
 * @returns {import('./permission.types').AuthorizationContext}
 * @throws {InvalidAuthorizationContextError|InvalidResourceError|InvalidActionError}
 */
function validateAuthorizationContext(context) {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    throw new InvalidAuthorizationContextError('expected an Authorization Context object', {
      received: context,
    });
  }

  const { userId, resource, action, resourceId = null, metadata = {} } = context;

  if (typeof userId !== 'string' || userId.length === 0) {
    throw new InvalidAuthorizationContextError('userId must be a non-empty string', { received: userId });
  }

  validateResource(resource);
  validateAction(action);

  if (resourceId !== null && typeof resourceId !== 'string') {
    throw new InvalidAuthorizationContextError('resourceId must be a string or null', {
      received: resourceId,
    });
  }

  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new InvalidAuthorizationContextError('metadata must be a plain object', { received: metadata });
  }

  return context;
}

/**
 * Validates the shape of a candidate Authorization Decision object
 * (AUTH-01 §3.9; AUTH-03 §4).
 *
 * @param {*} decision
 * @returns {import('./permission.types').AuthorizationDecision}
 * @throws {InvalidAuthorizationDecisionError|InvalidAuthorizationContextError}
 */
function validateAuthorizationDecision(decision) {
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) {
    throw new InvalidAuthorizationDecisionError('expected an Authorization Decision object', {
      received: decision,
    });
  }

  const { outcome, context, reason = null, decidedAt } = decision;

  validateAuthorizationDecisionOutcome(outcome);
  validateAuthorizationContext(context);

  if (reason !== null && typeof reason !== 'string') {
    throw new InvalidAuthorizationDecisionError('reason must be a string or null', { received: reason });
  }

  if (typeof decidedAt !== 'string' || Number.isNaN(Date.parse(decidedAt))) {
    throw new InvalidAuthorizationDecisionError('decidedAt must be an ISO timestamp string', {
      received: decidedAt,
    });
  }

  return decision;
}

module.exports = {
  isValidResource,
  isValidAction,
  isValidPermissionCategory,
  isValidPermissionStatus,
  isValidAuthorizationDecisionOutcome,
  validateResource,
  validateAction,
  validatePermissionCategory,
  validatePermissionStatus,
  validateAuthorizationDecisionOutcome,
  validatePermission,
  validateAuthorizationContext,
  validateAuthorizationDecision,
};
