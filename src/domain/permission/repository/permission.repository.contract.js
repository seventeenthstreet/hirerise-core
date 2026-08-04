'use strict';

/**
 * @file src/domain/permission/repository/permission.repository.contract.js
 *
 * WP-ADMIN-04F-02 — Permission Repository
 *
 * The Permission Repository contract: the persistence-only surface future
 * services (Registry, Governance, Evaluation — all out of this WP's
 * scope) are expected to depend on, per WP-ADMIN-04F-02's "Repository
 * Interface — define the repository contract used by future services"
 * deliverable.
 *
 * Mirrors the Snapshot Repository's interface convention
 * (modules/snapshot-intelligence/repository/interfaces/snapshot.repository.interfaces.js):
 * an abstract base class whose every method throws unless overridden,
 * rather than the domain layer's plain-object/factory-function
 * convention — a repository is a *behavior* boundary (I/O against a
 * store), not a *value* boundary, so a class is the appropriate shape
 * here even though nothing else in this domain module uses one.
 *
 * Extending this class is optional, not required, for an implementation
 * to be usable — what matters is the method surface itself. Extending it
 * is still the recommended path (as with SnapshotRepository) because it
 * turns a forgotten method into a clear "not implemented" error instead
 * of a silent `undefined is not a function`.
 *
 * Every method here is persistence-only, per the Repository Boundaries
 * section of WP-ADMIN-04F-02: no governance, no lifecycle transitions, no
 * evaluation, no business filtering beyond the exact-match lookups named
 * below.
 */

const { PermissionRepositoryError } = require('./permission.repository.errors');

function notImplemented(className, methodName) {
  throw new PermissionRepositoryError(
    `${className}.${methodName}() is not implemented`,
    'PERMISSION_REPOSITORY_METHOD_NOT_IMPLEMENTED',
    { className, methodName },
  );
}

/**
 * @typedef {Object} PermissionRepositoryListResult
 * @property {import('../permission.types').Permission[]} items
 * @property {number} total
 */

class PermissionRepository {
  /**
   * Persists a new Permission built from domain-shaped input. Validates
   * via the domain factory (permission.model.createPermission) before
   * insert.
   *
   * @param {Object} input
   * @param {import('../permission.types').Resource} input.resource
   * @param {import('../permission.types').Action} input.action
   * @param {import('../permission.types').PermissionCategory} [input.category]
   * @param {import('../permission.types').PermissionStatus} [input.status]
   * @param {string} [input.description]
   * @returns {Promise<import('../permission.types').Permission & {id: string, createdAt: string, updatedAt: string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async create(input) {
    notImplemented(this.constructor.name, 'create');
  }

  /** @param {string} id @returns {Promise<object|null>} */
  // eslint-disable-next-line no-unused-vars
  async findById(id) {
    notImplemented(this.constructor.name, 'findById');
  }

  /**
   * Lookup by Permission identifier — the domain's stable, unique
   * `name` (`${resource}:${action}`, AUTH-04 §7).
   * @param {string} name @returns {Promise<object|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async findByName(name) {
    notImplemented(this.constructor.name, 'findByName');
  }

  /**
   * Updates the mutable fields of an existing Permission (category,
   * status, description). `resource`/`action` — and therefore `name` —
   * are immutable after creation, per AUTH-04 §7 Stable Permission
   * Identity; this is a persistence-boundary safeguard for an invariant
   * the domain layer already declares, not a new business rule.
   *
   * @param {string} id
   * @param {Object} updates
   * @param {import('../permission.types').PermissionCategory} [updates.category]
   * @param {import('../permission.types').PermissionStatus} [updates.status]
   * @param {string} [updates.description]
   * @returns {Promise<object|null>} the updated row, or null if id does not exist
   */
  // eslint-disable-next-line no-unused-vars
  async update(id, updates) {
    notImplemented(this.constructor.name, 'update');
  }

  /** @param {string} id @returns {Promise<boolean>} whether a row was deleted */
  // eslint-disable-next-line no-unused-vars
  async delete(id) {
    notImplemented(this.constructor.name, 'delete');
  }

  /** @param {string} id @returns {Promise<boolean>} */
  // eslint-disable-next-line no-unused-vars
  async existsById(id) {
    notImplemented(this.constructor.name, 'existsById');
  }

  /** @param {string} name @returns {Promise<boolean>} */
  // eslint-disable-next-line no-unused-vars
  async existsByName(name) {
    notImplemented(this.constructor.name, 'existsByName');
  }

  /**
   * @param {import('../permission.types').Resource} resource
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRepositoryListResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async findByResource(resource, options) {
    notImplemented(this.constructor.name, 'findByResource');
  }

  /**
   * @param {import('../permission.types').Action} action
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRepositoryListResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async findByAction(action, options) {
    notImplemented(this.constructor.name, 'findByAction');
  }

  /**
   * @param {import('../permission.types').PermissionCategory} category
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRepositoryListResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async findByCategory(category, options) {
    notImplemented(this.constructor.name, 'findByCategory');
  }

  /**
   * @param {import('../permission.types').PermissionStatus} status
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRepositoryListResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async findByStatus(status, options) {
    notImplemented(this.constructor.name, 'findByStatus');
  }

  /**
   * Unfiltered, paginated listing of every Permission.
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRepositoryListResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async list(options) {
    notImplemented(this.constructor.name, 'list');
  }

  /**
   * Case-insensitive substring search across `name` and `description`.
   * Not business filtering (no status/category/lifecycle rules applied)
   * — purely a text-match query, per WP-ADMIN-04F-02's "Search
   * Permissions" deliverable and "Do NOT implement business filtering"
   * boundary.
   *
   * @param {string} term
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRepositoryListResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async search(term, options) {
    notImplemented(this.constructor.name, 'search');
  }
}

/**
 * Runtime contract-compliance check, mirroring the Snapshot Repository's
 * assertRepositoryContractCompliance. Duck-typed on purpose (checks
 * method presence, not `instanceof`) per this codebase's existing
 * convention that extending an interface class is recommended, not
 * required (e.g. shared/repositories/base.repository.js is not required
 * by any of its consumers either).
 *
 * @param {object} candidate
 * @throws {PermissionRepositoryError} if any required method is missing
 */
function assertPermissionRepositoryContractCompliance(candidate) {
  const requiredMethods = [
    'create',
    'findById',
    'findByName',
    'update',
    'delete',
    'existsById',
    'existsByName',
    'findByResource',
    'findByAction',
    'findByCategory',
    'findByStatus',
    'list',
    'search',
  ];

  const missing = requiredMethods.filter((method) => typeof candidate?.[method] !== 'function');

  if (missing.length > 0) {
    throw new PermissionRepositoryError(
      `Object does not satisfy the PermissionRepository contract — missing: ${missing.join(', ')}`,
      'PERMISSION_REPOSITORY_CONTRACT_VIOLATION',
      { missing },
    );
  }
}

module.exports = {
  PermissionRepository,
  assertPermissionRepositoryContractCompliance,
};
