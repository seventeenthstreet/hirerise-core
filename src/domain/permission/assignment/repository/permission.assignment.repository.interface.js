'use strict';

/**
 * @file src/domain/permission/assignment/repository/permission.assignment.repository.interface.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 *
 * Assignment's dedicated, isolated persistence boundary — per this WP's
 * Storage Boundary section: "Create a dedicated Assignment persistence
 * layer... Do not extend permissions / Permission Repository / Registry
 * ... Assignment persistence is a separate concern." This interface
 * (and ./permission.assignment.repository.inMemory.js) does not touch
 * `../../repository/permission.repository.js` or any table the certified
 * Permission Repository owns.
 *
 * Structural precedent: this file mirrors
 * `modules/snapshot-intelligence/repository/interfaces/snapshot.repository.interfaces.js`
 * — an abstract base class where every method throws `notImplemented()`
 * unless overridden, giving a concrete implementation a clear "not
 * implemented" error for any method it forgets, in a codebase that is
 * otherwise plain JS with no compile-time interface enforcement. This
 * is a different domain's file, so it is illustrative precedent, not
 * shared code — nothing here requires anything from
 * `modules/snapshot-intelligence/`.
 *
 * WP-approved scope: this WP implements exactly one concrete
 * implementation of this interface — `InMemoryAssignmentRepository`. No
 * SQL, no Supabase, no schema, no migrations (explicitly deferred to a
 * future persistence work package per this WP's review).
 */

const { PermissionAssignmentError } = require('../permission.assignment.errors');

function notImplemented(className, methodName) {
  throw new PermissionAssignmentError(
    `${className}.${methodName}() is not implemented`,
    'ASSIGNMENT_REPOSITORY_METHOD_NOT_IMPLEMENTED',
    { className, methodName },
  );
}

/**
 * @implements {AssignmentRepository}
 */
class AssignmentRepository {
  /**
   * Creates a new Assignment. Must throw `DuplicateAssignmentError` if
   * an Assignment already exists for `assignment.assignmentIdentity` —
   * this is the Repository's Assignment Integrity guarantee (WP §5:
   * "duplicate prevention"). Idempotent create-or-return behavior is the
   * Service's responsibility, layered on top of this strict method.
   * @param {import('../permission.assignment.model').Assignment} assignment
   * @returns {Promise<import('../permission.assignment.model').Assignment>}
   */
  // eslint-disable-next-line no-unused-vars
  async create(assignment) {
    notImplemented(this.constructor.name, 'create');
  }

  /**
   * Deletes an Assignment by identity. Must be safe to call for an
   * identity that does not exist (WP §3: "Repeated revocation shall be
   * safe") — returns whether an Assignment was actually deleted, never
   * throws for a missing identity.
   * @param {string} assignmentIdentity
   * @returns {Promise<boolean>} true if an Assignment was deleted, false if none existed
   */
  // eslint-disable-next-line no-unused-vars
  async delete(assignmentIdentity) {
    notImplemented(this.constructor.name, 'delete');
  }

  /**
   * @param {string} assignmentIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment | null>}
   */
  // eslint-disable-next-line no-unused-vars
  async find(assignmentIdentity) {
    notImplemented(this.constructor.name, 'find');
  }

  /**
   * Like `find`, but throws `AssignmentNotFoundError` instead of
   * returning null. Provided for completeness/future strict-lookup
   * callers — no method on `PermissionAssignmentService` currently
   * requires this (see `permission.assignment.errors.js`'s
   * `AssignmentNotFoundError` doc for why `revokePermission()`
   * deliberately never uses it).
   * @param {string} assignmentIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment>}
   */
  // eslint-disable-next-line no-unused-vars
  async get(assignmentIdentity) {
    notImplemented(this.constructor.name, 'get');
  }

  /**
   * @param {string} principalId
   * @returns {Promise<import('../permission.assignment.model').Assignment[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async findByPrincipal(principalId) {
    notImplemented(this.constructor.name, 'findByPrincipal');
  }

  /**
   * @param {string} permissionIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async findByPermission(permissionIdentity) {
    notImplemented(this.constructor.name, 'findByPermission');
  }

  /**
   * @returns {Promise<number>}
   */
  async count() {
    notImplemented(this.constructor.name, 'count');
  }
}

module.exports = {
  AssignmentRepository,
};
