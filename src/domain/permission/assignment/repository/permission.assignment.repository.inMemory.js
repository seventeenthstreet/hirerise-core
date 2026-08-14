'use strict';

/**
 * @file src/domain/permission/assignment/repository/permission.assignment.repository.inMemory.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 *
 * In-memory reference implementation of AssignmentRepository — approved
 * scope per this WP's review: "In-memory persistence is approved...
 * Do not introduce SQL / Supabase / database schema / migrations. Those
 * belong to a future persistence work package." Zero infrastructure
 * dependencies: the entire store is a single in-process Map. No
 * Supabase, no SQL, no filesystem, no network — mirroring
 * `modules/snapshot-intelligence/repository/inMemory/InMemorySnapshotRepository.js`'s
 * own "zero infrastructure dependencies" convention (a different
 * domain's file, used here only as structural precedent).
 *
 * Stores Assignment objects exactly as returned by
 * `../permission.assignment.model.js#createAssignment` — already
 * validated and frozen, so no separate mapping layer is needed the way
 * Snapshot's DTO boundary needs one.
 */

const { AssignmentRepository } = require('./permission.assignment.repository.interface');
const { DuplicateAssignmentError, AssignmentNotFoundError } = require('../permission.assignment.errors');

class InMemoryAssignmentRepository extends AssignmentRepository {
  constructor() {
    super();
    /** @type {Map<string, import('../permission.assignment.model').Assignment>} */
    this._store = new Map();
  }

  /**
   * @param {import('../permission.assignment.model').Assignment} assignment
   * @returns {Promise<import('../permission.assignment.model').Assignment>}
   */
  async create(assignment) {
    if (this._store.has(assignment.assignmentIdentity)) {
      throw new DuplicateAssignmentError(assignment.assignmentIdentity);
    }
    this._store.set(assignment.assignmentIdentity, assignment);
    return assignment;
  }

  /**
   * @param {string} assignmentIdentity
   * @returns {Promise<boolean>}
   */
  async delete(assignmentIdentity) {
    return this._store.delete(assignmentIdentity);
  }

  /**
   * @param {string} assignmentIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment | null>}
   */
  async find(assignmentIdentity) {
    return this._store.get(assignmentIdentity) ?? null;
  }

  /**
   * @param {string} assignmentIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment>}
   */
  async get(assignmentIdentity) {
    const assignment = this._store.get(assignmentIdentity);
    if (!assignment) {
      throw new AssignmentNotFoundError(assignmentIdentity);
    }
    return assignment;
  }

  /**
   * @param {string} principalId
   * @returns {Promise<import('../permission.assignment.model').Assignment[]>}
   */
  async findByPrincipal(principalId) {
    return Array.from(this._store.values()).filter((a) => a.principalId === principalId);
  }

  /**
   * @param {string} permissionIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment[]>}
   */
  async findByPermission(permissionIdentity) {
    return Array.from(this._store.values()).filter((a) => a.permissionIdentity === permissionIdentity);
  }

  /**
   * @returns {Promise<number>}
   */
  async count() {
    return this._store.size;
  }
}

module.exports = {
  InMemoryAssignmentRepository,
};
