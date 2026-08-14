'use strict';

/**
 * @file src/domain/permission/assignment/permission.assignment.model.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 *
 * Assignment as a first-class application concept: a grant of a single
 * Permission (identified the same way the certified layers already
 * identify one — `${resource}:${action}`, per
 * ../permission.model.js#buildPermissionName) to a single Principal.
 * Deliberately not a Domain-layer file (it does not live under
 * ../permission.model.js) — Assignment is an application-layer concept
 * introduced by this WP, not part of the certified AUTH-01 Domain.
 *
 * Per this WP's Assignment Integrity requirement, an Assignment's
 * identity is immutable and deterministic: the same (principalId,
 * permissionIdentity) pair always produces the same
 * `assignmentIdentity`, which is what makes duplicate-prevention and
 * idempotent assignment possible without any additional bookkeeping.
 */

const { buildPermissionName } = require('../permission.model');
const { InvalidAssignmentError } = require('./permission.assignment.errors');

/**
 * @typedef {Object} Assignment
 * @property {string} assignmentIdentity - deterministic, immutable: `${principalId}::${permissionIdentity}`
 * @property {string} principalId
 * @property {string} permissionIdentity - `${resource}:${action}`, matching the certified Permission Identity
 * @property {import('../permission.types').Resource} resource
 * @property {import('../permission.types').Action} action
 * @property {string} assignedAt - ISO 8601 timestamp
 */

/**
 * Builds the deterministic identity for an (principalId, permissionIdentity)
 * pair. Exposed separately from `createAssignment` so callers (the
 * Service, the Repository) can compute/look up an identity without
 * constructing a full Assignment object.
 *
 * @param {string} principalId
 * @param {string} permissionIdentity
 * @returns {string}
 */
function buildAssignmentIdentity(principalId, permissionIdentity) {
  return `${principalId}::${permissionIdentity}`;
}

/**
 * Constructs a well-formed, deeply frozen Assignment. Does not perform
 * Permission existence/evaluability/assignability checks — those are the
 * Service's responsibility (consuming Registry, Evaluation, and the
 * Assignment Policy); this factory only guarantees a structurally valid,
 * immutable Assignment shape, mirroring how
 * ../permission.model.js#createPermission is scoped to shape validation
 * only.
 *
 * @param {Object} input
 * @param {string} input.principalId
 * @param {import('../permission.types').Resource} input.resource
 * @param {import('../permission.types').Action} input.action
 * @param {string} [input.assignedAt] - defaults to now
 * @returns {Readonly<Assignment>}
 */
function createAssignment({ principalId, resource, action, assignedAt } = {}) {
  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw new InvalidAssignmentError('Assignment requires a non-empty string "principalId"', { received: principalId });
  }
  if (typeof resource !== 'string' || resource.length === 0) {
    throw new InvalidAssignmentError('Assignment requires a non-empty string "resource"', { received: resource });
  }
  if (typeof action !== 'string' || action.length === 0) {
    throw new InvalidAssignmentError('Assignment requires a non-empty string "action"', { received: action });
  }

  const permissionIdentity = buildPermissionName(resource, action);

  return Object.freeze({
    assignmentIdentity: buildAssignmentIdentity(principalId, permissionIdentity),
    principalId,
    permissionIdentity,
    resource,
    action,
    assignedAt: assignedAt ?? new Date().toISOString(),
  });
}

module.exports = {
  buildAssignmentIdentity,
  createAssignment,
};
