'use strict';

/**
 * @file src/domain/permission/assignment/permission.assignment.service.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 *
 * The authoritative application layer for managing Permission
 * assignments to Principals. Consumes:
 *   - Permission Registry (WP-ADMIN-04F-03)   — Permission discovery
 *   - Authorization Evaluation Engine (WP-ADMIN-04F-05) — reused for its
 *     existence/evaluability precondition check only (see below)
 *   - AssignmentRepository (this WP, in-memory only) — Assignment's own
 *     isolated persistence
 *   - AssignmentPolicy (this WP)               — the grantability
 *     question, kept separate from Evaluation's authorization question
 *
 * Dependency direction: Assignment -> Registry, Assignment -> Evaluation
 * Engine, Assignment -> AssignmentRepository. Never bypasses Registry,
 * never bypasses Evaluation, never touches the Permission Repository
 * directly, never touches Governance.
 *
 * ── Why both Registry and Evaluation are consulted, and for what ───────
 * WP-ADMIN-04F-06's review is explicit: "Do not use Allow / Deny as the
 * criterion for whether a Permission may be assigned... If assignment
 * policy is required, implement it as an internal Assignment-layer
 * policy abstraction." Concretely, this Service:
 *
 *   1. Looks up the Permission via `registry.getPermissionByIdentity()`
 *      — Registry is the source of Permission discovery and gives this
 *      Service the `status` it needs for its own `AssignmentPolicy`
 *      decision (grantability).
 *   2. Also calls `evaluationEngine.evaluate()` — reused, not
 *      duplicated, per this WP's "Reuse the Evaluation Engine where
 *      appropriate. Do NOT duplicate Evaluation logic" instruction. This
 *      call is used ONLY for its Domain-level request validation (an
 *      invalid Resource/Action enum value surfaces here as the same
 *      `InvalidResourceError`/`InvalidActionError` Evaluation itself
 *      raises) and as an existence/evaluability precondition (a
 *      `PermissionNotFoundError`/`PermissionNotEvaluableError` from
 *      Evaluation is translated into `PermissionNotAssignableError`).
 *      The resulting Decision's `outcome` (Allow/Deny) is deliberately
 *      never read — seeing `decision` at all is incidental to catching
 *      the call not throwing; nothing in this file branches on it.
 *   3. Separately asks `assignmentPolicy.isAssignable(entry.status)` —
 *      this, not Evaluation's Decision, is the actual grantability
 *      determination, per this WP's review.
 */

const { permissionRegistry: defaultRegistry } = require('../registry/permission.registry');
const { authorizationEvaluationEngine: defaultEvaluationEngine } = require('../evaluation/permission.evaluation.engine');
const { buildPermissionName } = require('../permission.model');
const { createAssignment, buildAssignmentIdentity } = require('./permission.assignment.model');
const { InMemoryAssignmentRepository } = require('./repository/permission.assignment.repository.inMemory');
const { defaultAssignmentPolicy } = require('./permission.assignment.policy');
const { InvalidAssignmentError, PermissionNotAssignableError } = require('./permission.assignment.errors');
const { validatePermissionRequestShape, validatePrincipalRequestShape } = require('./permission.assignment.validation');

/**
 * Validates the shape of a permission-scoped (but not principal-scoped)
 * request — used only by `listAssignments`, the one operation that
 * names a Permission without naming a Principal.
 * @private
 */
function validatePermissionOnlyRequestShape(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new InvalidAssignmentError('request must be a non-null object', {
      received: request === null ? 'null' : typeof request,
    });
  }
  const { resource, action } = request;
  if (typeof resource !== 'string' || resource.length === 0) {
    throw new InvalidAssignmentError('request requires a non-empty string "resource"', { received: resource });
  }
  if (typeof action !== 'string' || action.length === 0) {
    throw new InvalidAssignmentError('request requires a non-empty string "action"', { received: action });
  }
}

class PermissionAssignmentService {
  /**
   * @param {import('../registry/permission.registry').PermissionRegistry} [registry]
   *   Defaults to the shared PermissionRegistry singleton.
   * @param {import('../evaluation/permission.evaluation.engine').AuthorizationEvaluationEngine} [evaluationEngine]
   *   Defaults to the shared AuthorizationEvaluationEngine singleton.
   * @param {import('./repository/permission.assignment.repository.interface').AssignmentRepository} [assignmentRepository]
   *   Defaults to a fresh `InMemoryAssignmentRepository` — this WP's
   *   approved persistence, isolated from the Permission Repository.
   * @param {import('./permission.assignment.policy').AssignmentPolicy} [assignmentPolicy]
   *   Defaults to the shared `defaultAssignmentPolicy` singleton.
   */
  constructor(
    registry = defaultRegistry,
    evaluationEngine = defaultEvaluationEngine,
    assignmentRepository = new InMemoryAssignmentRepository(),
    assignmentPolicy = defaultAssignmentPolicy,
  ) {
    this._registry = registry;
    this._evaluationEngine = evaluationEngine;
    this._assignmentRepository = assignmentRepository;
    this._assignmentPolicy = assignmentPolicy;
  }

  /**
   * Runs the shared preconditions for `assignPermission()`: the
   * Evaluation precondition (existence + Domain validity + evaluability
   * — never its Decision outcome), Registry discovery, and the
   * Assignment Policy's grantability check. Returns the resolved
   * Registry entry.
   * @private
   */
  async _requireAssignableEntry({ principalId, resource, action }) {
    // Reused, not duplicated: this call also re-validates resource/action
    // against the Domain layer's enums (via Evaluation's own Context
    // construction) and confirms the identity is at least evaluable.
    // Its Decision outcome is intentionally discarded — see file header.
    try {
      await this._evaluationEngine.evaluate({ userId: principalId, resource, action });
    } catch (error) {
      if (error?.name === 'PermissionNotFoundError' || error?.name === 'PermissionNotEvaluableError') {
        const identity = buildPermissionName(resource, action);
        throw new PermissionNotAssignableError(identity, error.message, { cause: error.name });
      }
      // Anything else (e.g. an invalid Resource/Action enum value) is a
      // genuine Domain-layer validation error — let it propagate as-is,
      // exactly as Evaluation itself would raise it.
      throw error;
    }

    // Registry remains the source of Permission discovery — looked up
    // directly (not inferred from Evaluation's explanation metadata) so
    // the Assignment Policy decision below is fed by Registry, never by
    // an Evaluation Decision.
    const identity = buildPermissionName(resource, action);
    const entry = await this._registry.getPermissionByIdentity(identity);
    if (!entry) {
      // Extremely unlikely to be reached (Evaluation above would already
      // have thrown PermissionNotFoundError for the same identity), but
      // guarded rather than assumed.
      throw new PermissionNotAssignableError(identity, 'no Registry entry found');
    }

    if (!this._assignmentPolicy.isAssignable(entry.status)) {
      throw new PermissionNotAssignableError(identity, `status "${entry.status}" is not assignable`, { status: entry.status });
    }

    return entry;
  }

  /**
   * Assigns a Permission to a Principal. Idempotent: repeated calls with
   * the same (principalId, resource, action) return the existing
   * Assignment without creating a duplicate or raising an error.
   *
   * @param {Object} request
   * @param {string} request.principalId
   * @param {import('../permission.types').Resource} request.resource
   * @param {import('../permission.types').Action} request.action
   * @returns {Promise<import('./permission.assignment.model').Assignment>}
   */
  async assignPermission(request) {
    validatePermissionRequestShape(request);
    const { principalId, resource, action } = request;

    const entry = await this._requireAssignableEntry({ principalId, resource, action });

    const assignmentIdentity = buildAssignmentIdentity(principalId, entry.identity);
    const existing = await this._assignmentRepository.find(assignmentIdentity);
    if (existing) {
      return existing;
    }

    const assignment = createAssignment({ principalId, resource, action });
    return this._assignmentRepository.create(assignment);
  }

  /**
   * Revokes a Permission from a Principal. Safe to call repeatedly —
   * revoking a non-existent Assignment is a no-op, never an error.
   *
   * @param {Object} request
   * @param {string} request.principalId
   * @param {import('../permission.types').Resource} request.resource
   * @param {import('../permission.types').Action} request.action
   * @returns {Promise<boolean>} true if an Assignment was revoked, false if none existed
   */
  async revokePermission(request) {
    validatePermissionRequestShape(request);
    const { principalId, resource, action } = request;
    const permissionIdentity = buildPermissionName(resource, action);
    const assignmentIdentity = buildAssignmentIdentity(principalId, permissionIdentity);
    return this._assignmentRepository.delete(assignmentIdentity);
  }

  /**
   * @param {Object} request
   * @param {string} request.principalId
   * @param {import('../permission.types').Resource} request.resource
   * @param {import('../permission.types').Action} request.action
   * @returns {Promise<boolean>}
   */
  async hasAssignment(request) {
    validatePermissionRequestShape(request);
    const { principalId, resource, action } = request;
    const permissionIdentity = buildPermissionName(resource, action);
    const assignmentIdentity = buildAssignmentIdentity(principalId, permissionIdentity);
    return (await this._assignmentRepository.find(assignmentIdentity)) !== null;
  }

  /**
   * All Assignments held by a Principal.
   * @param {Object} request
   * @param {string} request.principalId
   * @returns {Promise<import('./permission.assignment.model').Assignment[]>}
   */
  async getAssignments(request) {
    validatePrincipalRequestShape(request);
    return this._assignmentRepository.findByPrincipal(request.principalId);
  }

  /**
   * All Assignments of a given Permission, across every Principal.
   * @param {Object} request
   * @param {import('../permission.types').Resource} request.resource
   * @param {import('../permission.types').Action} request.action
   * @returns {Promise<import('./permission.assignment.model').Assignment[]>}
   */
  async listAssignments(request) {
    validatePermissionOnlyRequestShape(request);
    const permissionIdentity = buildPermissionName(request.resource, request.action);
    return this._assignmentRepository.findByPermission(permissionIdentity);
  }
}

module.exports = {
  PermissionAssignmentService,
  // Convenience singleton, matching this domain's existing singleton
  // convention. Uses its own private InMemoryAssignmentRepository
  // instance — Assignment state is not shared with any other consumer
  // by default.
  permissionAssignmentService: new PermissionAssignmentService(),
};
