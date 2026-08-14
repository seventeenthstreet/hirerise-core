'use strict';

/**
 * @file src/domain/permission/registry/permission.registry.js
 *
 * WP-ADMIN-04F-03 — Enterprise Permission Registry
 *
 * The enterprise catalog of Permission definitions (AUTH-04 §4). A
 * read-oriented application-layer service that consumes the certified
 * Permission Repository (WP-ADMIN-04F-02) — it performs no direct
 * database access, introduces no new persistence, and is not a second
 * repository: every method here ultimately delegates to
 * `../repository/permission.repository.js`.
 *
 * What this IS (per AUTH-04 §4 and this WP's Architectural Requirements):
 *   - Permission discovery (list / lookup by identity / resource / action
 *     / category / status) — thin wrappers over the Repository's own
 *     query methods.
 *   - The enterprise catalog view (Registry Catalog) — the complete set
 *     of registered Permissions, decorated with Registry Metadata.
 *   - Lifecycle Visibility — read-only positioning within the AUTH-04 §6
 *     Governance Lifecycle (see ./permission.registry.lifecycle.js).
 *   - Capability Ownership representation (see
 *     ./permission.registry.ownership.js).
 *   - Registry Validation — catalog-wide consistency checks (duplicate
 *     identities, missing metadata, malformed entries).
 *
 * What this is explicitly NOT (per this WP's boundaries and AUTH-04 §8):
 *   - NOT a second persistence layer — no table, no migration, no direct
 *     Supabase access anywhere in this file.
 *   - NOT an Authorization Evaluator (AUTH-03) — this module never
 *     computes an Allow/Deny outcome.
 *   - NOT a governance workflow engine (AUTH-04 §3) — it exposes *where*
 *     a Permission sits in the Governance Lifecycle, never *how* it gets
 *     there (no proposal, review, approval, or retirement operations).
 *   - NOT Permission Assignment — it has no concept of a User.
 */

const { permissionRepository: defaultRepository } = require('../repository/permission.repository');
const { resolveCapabilityOwner } = require('./permission.registry.ownership');
const { describeLifecycleStage, listLifecycleStages } = require('./permission.registry.lifecycle');
const { PermissionRegistryValidationError } = require('./permission.registry.errors');
const logger = require('../../../utils/logger');

function requireNonEmptyString(value, argName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PermissionRegistryValidationError(`${argName} must be a non-empty string`, { received: value });
  }
  return value;
}

/**
 * @typedef {Object} PermissionRegistryEntry
 * @property {string} id
 * @property {string} identity - the Permission's Stable Permission Identity (AUTH-04 §7); equal to `name`
 * @property {string} name
 * @property {string} resource
 * @property {string} action
 * @property {string|null} category
 * @property {string} status
 * @property {string|null} description
 * @property {string|null} capabilityOwner - Capability Ownership (AUTH-04 §3.1/§7)
 * @property {{status: string, label: string, stageIndex: number, isTerminal: boolean}} lifecycleStage - Lifecycle Visibility (AUTH-04 §6)
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} PermissionRegistryListResult
 * @property {PermissionRegistryEntry[]} items
 * @property {number} total
 */

/**
 * @typedef {Object} RegistryValidationReport
 * @property {boolean} valid
 * @property {number} totalEntries
 * @property {Array<{identity: string, entryIds: string[]}>} duplicateIdentities
 * @property {Array<{id: string, missingFields: string[]}>} missingMetadata
 * @property {Array<{id: string|null, reason: string}>} malformedEntries
 */

class PermissionRegistry {
  /**
   * @param {import('../repository/permission.repository.contract').PermissionRepository} [repository]
   *   Defaults to the shared SupabasePermissionRepository singleton
   *   (../repository/permission.repository.js). Constructor-injectable
   *   for testing, mirroring
   *   modules/knowledge-runtime/decision/decisionTypeRegistry.js's DI
   *   convention.
   */
  constructor(repository = defaultRepository) {
    this._repository = repository;
  }

  /**
   * Decorates a persisted Permission (as returned by the Repository) with
   * Registry Metadata: Permission Identity, Capability Ownership, and
   * Lifecycle Visibility — the "Registry Metadata" / "Lifecycle
   * Visibility" / "Capability Ownership" deliverables. Never mutates the
   * frozen Permission it receives.
   *
   * @param {object} permission - a Permission as returned by the Repository
   * @returns {PermissionRegistryEntry}
   * @private
   */
  _toRegistryEntry(permission) {
    return Object.freeze({
      id: permission.id,
      identity: permission.name,
      name: permission.name,
      resource: permission.resource,
      action: permission.action,
      category: permission.category,
      status: permission.status,
      description: permission.description,
      capabilityOwner: resolveCapabilityOwner(permission.resource),
      lifecycleStage: describeLifecycleStage(permission.status),
      createdAt: permission.createdAt,
      updatedAt: permission.updatedAt,
    });
  }

  _toRegistryListResult({ items, total }) {
    return { items: items.map((permission) => this._toRegistryEntry(permission)), total };
  }

  // ── Registry Discovery ──────────────────────────────────────────────

  /**
   * Lists the enterprise Permission catalog, paginated.
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRegistryListResult>}
   */
  async listPermissions(options) {
    return this._toRegistryListResult(await this._repository.list(options));
  }

  /**
   * Lookup by internal id.
   * @param {string} id
   * @returns {Promise<PermissionRegistryEntry|null>}
   */
  async getPermission(id) {
    requireNonEmptyString(id, 'id');
    const permission = await this._repository.findById(id);
    return permission ? this._toRegistryEntry(permission) : null;
  }

  /**
   * Lookup by Permission Identity (AUTH-04 §7 Stable Permission Identity
   * — `${resource}:${action}`).
   * @param {string} identity
   * @returns {Promise<PermissionRegistryEntry|null>}
   */
  async getPermissionByIdentity(identity) {
    requireNonEmptyString(identity, 'identity');
    const permission = await this._repository.findByName(identity);
    return permission ? this._toRegistryEntry(permission) : null;
  }

  /**
   * @param {import('../permission.types').Resource} resource
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRegistryListResult>}
   */
  async findByResource(resource, options) {
    requireNonEmptyString(resource, 'resource');
    return this._toRegistryListResult(await this._repository.findByResource(resource, options));
  }

  /**
   * @param {import('../permission.types').Action} action
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRegistryListResult>}
   */
  async findByAction(action, options) {
    requireNonEmptyString(action, 'action');
    return this._toRegistryListResult(await this._repository.findByAction(action, options));
  }

  /**
   * @param {import('../permission.types').PermissionCategory} category
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRegistryListResult>}
   */
  async findByCategory(category, options) {
    requireNonEmptyString(category, 'category');
    return this._toRegistryListResult(await this._repository.findByCategory(category, options));
  }

  /**
   * @param {import('../permission.types').PermissionStatus} status
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRegistryListResult>}
   */
  async findByStatus(status, options) {
    requireNonEmptyString(status, 'status');
    return this._toRegistryListResult(await this._repository.findByStatus(status, options));
  }

  // ── Registry Catalog ────────────────────────────────────────────────

  /**
   * The enterprise catalog view (AUTH-04 §4.2 "What the Registry
   * Represents") — the complete, paginated set of registered enterprise
   * Permissions. Deliberately the same underlying call as
   * `listPermissions()` (Registry Discovery's "list Permissions") rather
   * than a second implementation: AUTH-04 does not describe the catalog
   * as a distinct query, only as what the whole vocabulary *is* — so this
   * method exists to give that concept its own name in the API, not its
   * own logic.
   *
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Promise<PermissionRegistryListResult>}
   */
  async getCatalog(options) {
    return this.listPermissions(options);
  }

  // ── Lifecycle Visibility ────────────────────────────────────────────

  /**
   * The full ordered Governance Lifecycle (AUTH-04 §6), for callers that
   * want to render the lifecycle itself rather than a single Permission's
   * position in it.
   * @returns {Array<{status: string, label: string, stageIndex: number, isTerminal: boolean}>}
   */
  getLifecycleStages() {
    return listLifecycleStages();
  }

  // ── Governance Write Passthrough ────────────────────────────────────
  // WP-ADMIN-04F-04 (Enterprise Permission Governance Services) requires
  // that "the Governance Service must never bypass the Registry" for
  // persistence updates (Governance -> Registry -> Repository ->
  // Database). Prior to that WP the Registry was read-only by design
  // (see this file's header). This single method is the "integration
  // strictly required" the Governance WP calls for: it performs no
  // lifecycle validation itself (that is the Governance layer's job,
  // per this WP's own "NOT a governance workflow engine" boundary) — it
  // only forwards an already-validated status change to the Repository
  // and re-decorates the result, so Governance never needs a direct
  // Repository reference.

  /**
   * Applies an already-governance-validated Permission Status change and
   * returns the updated catalog entry. Callers (the Governance Service)
   * are responsible for validating the transition before calling this —
   * this method trusts its input and performs no lifecycle-transition
   * validation of its own.
   *
   * @param {string} id
   * @param {import('../permission.types').PermissionStatus} status
   * @returns {Promise<PermissionRegistryEntry|null>} null if id does not exist
   */
  async applyLifecycleTransition(id, status) {
    requireNonEmptyString(id, 'id');
    requireNonEmptyString(status, 'status');
    const updated = await this._repository.update(id, { status });
    return updated ? this._toRegistryEntry(updated) : null;
  }

  // ── Registry Validation ─────────────────────────────────────────────

  /**
   * Checks catalog-wide consistency: duplicate Permission Identities,
   * entries missing expected Registry Metadata, and malformed entries.
   * This is Registry Validation (AUTH-04 §4.4's Permission Consistency
   * dependency), NOT authorization-decision validation — it never
   * evaluates Allow/Deny, and never validates a single Permission's shape
   * in isolation (the Repository already guarantees that for every entry
   * it returns; this checks properties of the *set*, plus catalog-level
   * completeness expectations the domain layer treats as optional but the
   * enterprise catalog still wants visibility into).
   *
   * @param {PermissionRegistryEntry[]} [entries] - defaults to the full
   *   catalog (`getCatalog()` with no pagination limit) if omitted, so a
   *   caller can validate an ad-hoc set (e.g. a page) or the whole
   *   registry.
   * @returns {Promise<RegistryValidationReport>}
   */
  async validateCatalog(entries) {
    const catalogEntries = entries ?? (await this.getCatalog({ limit: Number.MAX_SAFE_INTEGER, offset: 0 })).items;

    const byIdentity = new Map();
    const missingMetadata = [];
    const malformedEntries = [];

    for (const entry of catalogEntries) {
      if (!entry || typeof entry !== 'object') {
        malformedEntries.push({ id: null, reason: 'entry is not an object' });
        continue;
      }

      const requiredFields = ['id', 'identity', 'resource', 'action', 'status'];
      const missingFields = requiredFields.filter((field) => entry[field] === undefined || entry[field] === null || entry[field] === '');

      if (missingFields.length > 0) {
        malformedEntries.push({ id: entry.id ?? null, reason: `missing required field(s): ${missingFields.join(', ')}` });
        continue;
      }

      // `category` is legitimately optional at the domain layer
      // (../permission.model.js's createPermission() defaults it to
      // null) — an uncategorized entry is not malformed, but it is
      // incomplete from the enterprise catalog's point of view, so it is
      // reported as a missing-metadata finding rather than a malformed
      // entry.
      if (entry.category === null || entry.category === undefined) {
        missingMetadata.push({ id: entry.id, missingFields: ['category'] });
      }

      if (!byIdentity.has(entry.identity)) {
        byIdentity.set(entry.identity, []);
      }
      byIdentity.get(entry.identity).push(entry.id);
    }

    const duplicateIdentities = [...byIdentity.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([identity, entryIds]) => ({ identity, entryIds }));

    const report = {
      valid: duplicateIdentities.length === 0 && malformedEntries.length === 0,
      totalEntries: catalogEntries.length,
      duplicateIdentities,
      missingMetadata,
      malformedEntries,
    };

    if (!report.valid) {
      logger.warn('[PermissionRegistry] catalog consistency issues found', {
        duplicateIdentities: duplicateIdentities.length,
        malformedEntries: malformedEntries.length,
      });
    }

    return report;
  }
}

module.exports = {
  PermissionRegistry,
  // Convenience singleton, matching this WP's own
  // `permissionRepository` convention (../repository/permission.repository.js)
  // and the codebase's existing `decisionTypeRegistry` singleton
  // (modules/knowledge-runtime/decision/decisionTypeRegistry.js).
  permissionRegistry: new PermissionRegistry(),
};
