'use strict';

/**
 * @file src/domain/permission/governance/permission.governance.service.js
 *
 * WP-ADMIN-04F-04 — Enterprise Permission Governance Services
 *
 * The Governance Service enforces the enterprise Permission lifecycle
 * defined by AUTH-04 §6 (Proposal -> Approval -> Publication -> Adoption
 * -> Deprecation -> Retirement). It consumes the certified Permission
 * Registry (WP-ADMIN-04F-03) — it performs no direct database access,
 * introduces no new persistence, and never bypasses the Registry
 * (Governance -> Registry -> Repository -> Database).
 *
 * What this IS (per this WP's Architectural Responsibility):
 *   - Permission lifecycle management (the six named transition
 *     operations below).
 *   - Lifecycle Transition Validation (delegated to
 *     ./permission.governance.lifecycle.js).
 *   - Governance rule enforcement — immutable Permission Identity,
 *     required metadata, Registry consistency, duplicate-identity
 *     prevention, duplicate lifecycle actions.
 *   - Governance Validation reporting.
 *
 * What this is explicitly NOT (per this WP's boundaries and AUTH-04 §8):
 *   - NOT an Authorization Evaluator — never computes an Allow/Deny
 *     outcome, never touches effective permissions.
 *   - NOT Permission Assignment or role management — has no concept of a
 *     User or a Role.
 *   - NOT a second Registry or Repository — every read goes through the
 *     injected Registry; every write goes through the Registry's
 *     `applyLifecycleTransition()` passthrough, never the Repository
 *     directly.
 */

const { permissionRegistry: defaultRegistry } = require('../registry/permission.registry');
const { PERMISSION_STATUS } = require('../permission.constants');
const {
  isValidLifecycleTransition,
  getNextLifecycleStatus,
  isTerminalLifecycleStatus,
} = require('./permission.governance.lifecycle');
const {
  InvalidLifecycleTransitionError,
  PermissionAlreadyPublishedError,
  PermissionAlreadyRetiredError,
  GovernanceValidationError,
  GovernanceConflictError,
} = require('./permission.governance.errors');
const logger = require('../../../utils/logger');

function requireNonEmptyString(value, argName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GovernanceValidationError(`${argName} must be a non-empty string`, { received: value });
  }
  return value;
}

/**
 * @typedef {Object} GovernanceTransitionReport
 * @property {boolean} valid
 * @property {string|null} fromStatus
 * @property {string|null} toStatus
 * @property {string[]} violations
 */

class PermissionGovernanceService {
  /**
   * @param {import('../registry/permission.registry').PermissionRegistry} [registry]
   *   Defaults to the shared PermissionRegistry singleton
   *   (../registry/permission.registry.js). Constructor-injectable for
   *   testing with a mocked Registry, mirroring
   *   ../registry/permission.registry.js's own DI convention for its
   *   Repository dependency.
   */
  constructor(registry = defaultRegistry) {
    this._registry = registry;
  }

  /**
   * Loads a Registry catalog entry by internal id, or throws if it does
   * not exist. Every lifecycle operation below starts here — Governance
   * never assumes a Permission it hasn't just re-fetched from the
   * Registry.
   * @private
   */
  async _requireEntry(id) {
    requireNonEmptyString(id, 'id');
    const entry = await this._registry.getPermission(id);
    if (!entry) {
      throw new GovernanceValidationError(`no Permission found for id "${id}"`, { id });
    }
    return entry;
  }

  /**
   * Governance rule: Permission Identity (`${resource}:${action}`,
   * AUTH-04 §7) is immutable once a Permission exists. Nothing in this
   * service ever writes `resource`, `action`, or `identity` — this
   * assertion exists so a future caller that tries to smuggle an
   * identity change through a governance operation fails loudly instead
   * of silently.
   * @private
   */
  _assertIdentityUnchanged(entry, requestedIdentity) {
    if (requestedIdentity !== undefined && requestedIdentity !== entry.identity) {
      throw new GovernanceConflictError(
        `Permission Identity is immutable and cannot be changed via governance (was "${entry.identity}", requested "${requestedIdentity}")`,
        { id: entry.id, identity: entry.identity, requestedIdentity },
      );
    }
  }

  /**
   * Executes a single validated forward lifecycle transition, shared by
   * every named operation below. Not exposed directly — callers use the
   * named stage operations (proposeToApproval, approve, publish, adopt,
   * deprecate, retire) so intent stays explicit at the call site, per
   * AUTH-04 §6 naming the stages individually rather than as a generic
   * "set status" operation.
   * @private
   */
  async _transition(id, expectedFromStatus, toStatus, { requestedIdentity } = {}) {
    const entry = await this._requireEntry(id);

    this._assertIdentityUnchanged(entry, requestedIdentity);

    if (isTerminalLifecycleStatus(entry.status)) {
      throw new PermissionAlreadyRetiredError(entry.identity, { id: entry.id });
    }

    if (expectedFromStatus && entry.status !== expectedFromStatus) {
      throw new InvalidLifecycleTransitionError(entry.status, toStatus, {
        id: entry.id,
        identity: entry.identity,
        reason: `expected current status "${expectedFromStatus}"`,
      });
    }

    if (!isValidLifecycleTransition(entry.status, toStatus)) {
      throw new InvalidLifecycleTransitionError(entry.status, toStatus, {
        id: entry.id,
        identity: entry.identity,
      });
    }

    const updated = await this._registry.applyLifecycleTransition(id, toStatus);
    if (!updated) {
      throw new GovernanceConflictError(`Registry reported no Permission for id "${id}" during transition`, {
        id,
        toStatus,
      });
    }

    logger.info('[PermissionGovernance] lifecycle transition applied', {
      id: updated.id,
      identity: updated.identity,
      fromStatus: entry.status,
      toStatus: updated.status,
    });

    return updated;
  }

  // ── Lifecycle Management (AUTH-04 §6) ───────────────────────────────

  /**
   * Proposal -> Approval.
   * @param {string} id
   * @returns {Promise<import('../registry/permission.registry').PermissionRegistryEntry>}
   */
  async approve(id) {
    return this._transition(id, PERMISSION_STATUS.PROPOSED, PERMISSION_STATUS.APPROVED);
  }

  /**
   * Approval -> Publication.
   * @param {string} id
   * @returns {Promise<import('../registry/permission.registry').PermissionRegistryEntry>}
   */
  async publish(id) {
    const entry = await this._requireEntry(id);

    if (entry.status === PERMISSION_STATUS.PUBLISHED) {
      throw new PermissionAlreadyPublishedError(entry.identity, { id: entry.id });
    }

    return this._transition(id, PERMISSION_STATUS.APPROVED, PERMISSION_STATUS.PUBLISHED);
  }

  /**
   * Publication -> Adoption.
   * @param {string} id
   * @returns {Promise<import('../registry/permission.registry').PermissionRegistryEntry>}
   */
  async adopt(id) {
    return this._transition(id, PERMISSION_STATUS.PUBLISHED, PERMISSION_STATUS.ADOPTED);
  }

  /**
   * Adoption -> Deprecation.
   * @param {string} id
   * @returns {Promise<import('../registry/permission.registry').PermissionRegistryEntry>}
   */
  async deprecate(id) {
    return this._transition(id, PERMISSION_STATUS.ADOPTED, PERMISSION_STATUS.DEPRECATED);
  }

  /**
   * Deprecation -> Retirement. Retirement is terminal (AUTH-04 §7); once
   * applied, no further governance transition is possible for this
   * Permission.
   * @param {string} id
   * @returns {Promise<import('../registry/permission.registry').PermissionRegistryEntry>}
   */
  async retire(id) {
    const entry = await this._requireEntry(id);

    if (entry.status === PERMISSION_STATUS.RETIRED) {
      throw new PermissionAlreadyRetiredError(entry.identity, { id: entry.id });
    }

    return this._transition(id, PERMISSION_STATUS.DEPRECATED, PERMISSION_STATUS.RETIRED);
  }

  /**
   * Generic entry point for callers that already hold a validated target
   * status (e.g. a governance UI driven off `getLifecycleStages()`)
   * rather than one of the named stage operations above. Applies the
   * exact same validation as the named operations — this is a dispatch
   * convenience, not a second code path.
   *
   * @param {string} id
   * @param {import('../permission.types').PermissionStatus} toStatus
   * @returns {Promise<import('../registry/permission.registry').PermissionRegistryEntry>}
   */
  async transitionTo(id, toStatus) {
    requireNonEmptyString(toStatus, 'toStatus');
    return this._transition(id, undefined, toStatus);
  }

  // ── Governance Validation ───────────────────────────────────────────

  /**
   * Reports whether a proposed transition would be accepted, without
   * applying it — Governance Validation (deliverable #7), distinct from
   * the Registry's catalog-wide `validateCatalog()`.
   *
   * @param {string} id
   * @param {import('../permission.types').PermissionStatus} toStatus
   * @returns {Promise<GovernanceTransitionReport>}
   */
  async validateTransition(id, toStatus) {
    requireNonEmptyString(toStatus, 'toStatus');
    const entry = await this._requireEntry(id);
    const violations = [];

    if (isTerminalLifecycleStatus(entry.status)) {
      violations.push(`Permission "${entry.identity}" is retired; no further transitions are possible`);
    } else if (!isValidLifecycleTransition(entry.status, toStatus)) {
      const expected = getNextLifecycleStatus(entry.status);
      violations.push(
        expected
          ? `cannot transition from "${entry.status}" to "${toStatus}"; the only valid next stage is "${expected}"`
          : `"${toStatus}" is not a recognized Governance Lifecycle stage`,
      );
    }

    return {
      valid: violations.length === 0,
      fromStatus: entry.status,
      toStatus,
      violations,
    };
  }
}

module.exports = {
  PermissionGovernanceService,
  // Convenience singleton, matching this WP's own Registry/Repository
  // singleton convention.
  permissionGovernanceService: new PermissionGovernanceService(),
};
