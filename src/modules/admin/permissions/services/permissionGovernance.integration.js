'use strict';

/**
 * @file src/modules/admin/permissions/services/permissionGovernance.integration.js
 *
 * WP-ADMIN-05C — Enterprise Permission Governance Integration
 *
 * The Permission Governance Integration Service is the smallest possible
 * layer between the transport (permissionGovernance.controller.js) and
 * the certified Governance domain (../../../../domain/permission/governance/
 * permission.governance.service.js). Per the certified architecture:
 *
 *   Permission Governance Controller
 *        -> Permission Governance Integration Service   (this file)
 *        -> permission.governance.service.js            (unmodified)
 *        -> Permission Registry -> Repository
 *
 * This file does exactly three things, and nothing else:
 *   1. invoke the certified governance service (one named stage method
 *      per operation — never the generic transitionTo(), so intent stays
 *      explicit at the call site, mirroring the domain service's own
 *      convention)
 *   2. map its result to the DTO shape the frontend already consumes
 *      (permission.registry.js's `_toRegistryEntry()` shape — the exact
 *      same shape returned by GET /registry/:id, so no new frontend
 *      type is introduced)
 *   3. emit the WP-ADMIN-05B audit infrastructure, fire-and-forget, only
 *      after the transition has already succeeded
 *
 * It holds NO lifecycle logic: every legality check (forward-only,
 * no-skip, terminal-state) still happens exclusively inside
 * permission.governance.service.js / permission.governance.lifecycle.js.
 * A rejected transition (e.g. InvalidLifecycleTransitionError) propagates
 * unchanged — this layer never catches or reinterprets it — and emits no
 * audit event, mirroring WP-ADMIN-05B's Assignment audit contract
 * ("only genuine state changes are audited").
 */

const { permissionGovernanceService: defaultGovernanceService } = require('../../../../domain/permission/governance/permission.governance.service');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');
const { ACTIONS: PERMISSION_AUDIT_ACTIONS, buildPermissionAuditEvent } = require('../audit/permissionAudit.constants');

/**
 * Maps a PermissionRegistryEntry (returned by every governance stage
 * method — see permission.registry.js's `applyLifecycleTransition()`)
 * to the DTO shape already used throughout this module (identical to
 * permissionRegistry.controller.js's `getPermissionById` response). No
 * field renaming, no derived data — the Registry entry already is the
 * DTO; this function exists as an explicit seam per this WP's Phase 2
 * "map DTOs" responsibility, so a future divergence between the
 * Registry's internal shape and the API's public shape has a single
 * place to happen.
 * @private
 */
function toPermissionDto(entry) {
  return entry;
}

/**
 * Fire-and-forget audit emission. Mirrors
 * permissionAssignment.controller.js's `emitPermissionAudit()` exactly
 * (WP-ADMIN-05B) — reused pattern, not reinvented.
 * @private
 */
function emitGovernanceAudit(action, adminId, entry, ipAddress) {
  logAdminAction(
    buildPermissionAuditEvent(action, adminId, entry.identity, { permissionId: entry.id, toStatus: entry.status }, ipAddress)
  ).catch(() => {});
}

class PermissionGovernanceIntegrationService {
  /**
   * @param {import('../../../../domain/permission/governance/permission.governance.service').PermissionGovernanceService} [governanceService]
   */
  constructor(governanceService = defaultGovernanceService) {
    this._governanceService = governanceService;
  }

  /**
   * @private
   * @param {'approve'|'publish'|'adopt'|'deprecate'|'retire'} method
   * @param {string} action - one of PERMISSION_AUDIT_ACTIONS
   */
  async _transition(method, action, id, adminId, ipAddress) {
    const updated = await this._governanceService[method](id);
    emitGovernanceAudit(action, adminId, updated, ipAddress);
    return toPermissionDto(updated);
  }

  /** Proposal -> Approval. */
  async approve(id, adminId, ipAddress) {
    return this._transition('approve', PERMISSION_AUDIT_ACTIONS.APPROVED, id, adminId, ipAddress);
  }

  /** Approval -> Publication. */
  async publish(id, adminId, ipAddress) {
    return this._transition('publish', PERMISSION_AUDIT_ACTIONS.PUBLISHED, id, adminId, ipAddress);
  }

  /** Publication -> Adoption. */
  async adopt(id, adminId, ipAddress) {
    return this._transition('adopt', PERMISSION_AUDIT_ACTIONS.ADOPTED, id, adminId, ipAddress);
  }

  /** Adoption -> Deprecation. */
  async deprecate(id, adminId, ipAddress) {
    return this._transition('deprecate', PERMISSION_AUDIT_ACTIONS.DEPRECATED, id, adminId, ipAddress);
  }

  /** Deprecation -> Retirement (terminal). */
  async retire(id, adminId, ipAddress) {
    return this._transition('retire', PERMISSION_AUDIT_ACTIONS.RETIRED, id, adminId, ipAddress);
  }
}

module.exports = {
  PermissionGovernanceIntegrationService,
  // Convenience singleton, matching this module's own Assignment/Registry
  // controller singleton convention.
  permissionGovernanceIntegrationService: new PermissionGovernanceIntegrationService(),
};
