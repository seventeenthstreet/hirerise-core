'use strict';

/**
 * @file src/modules/admin/permissions/services/permissionHistory.integration.js
 *
 * WP-ADMIN-05D — Enterprise Permission Audit & Governance History
 *
 * The Permission History Integration Service is the smallest possible
 * layer between the transport (permissionHistory.controller.js) and the
 * certified Administrator Audit Infrastructure, reached via
 * permissionHistory.repository.js. Per the certified architecture:
 *
 *   Permission History Controller
 *        -> Permission History Integration Service   (this file)
 *        -> Administrator Audit Repository (permissionHistory.repository.js)
 *        -> admin_logs
 *
 * This file does exactly two things, and nothing else:
 *   1. for the single-Permission timeline, resolve the route's `:id`
 *      (the Registry's internal id — the same param `GET /registry/:id`
 *      already uses) to the Permission Identity that `admin_logs.entity_id`
 *      actually stores, via the certified Registry's own `getPermission(id)`
 *      — never a second id/identity mapping invented here
 *   2. map each raw `admin_logs` row to the timeline event DTO the
 *      frontend consumes
 *
 * It holds NO audit-generation logic (it never writes to admin_logs) and
 * NO lifecycle logic. History is read-only, exactly as the certified
 * architecture requires.
 */

const { permissionRegistry: defaultRegistry } = require('../../../../domain/permission/registry/permission.registry');
const { permissionHistoryRepository: defaultHistoryRepository } = require('../history/permissionHistory.repository');

/**
 * Maps one raw `admin_logs` row to the Permission History timeline DTO.
 * A pure, explicit shape — not a passthrough of the raw DB row — so the
 * frontend never depends on `admin_logs`' internal column names.
 * @private
 */
function toHistoryEvent(row) {
  return {
    id: row.id,
    action: row.action,
    adminId: row.admin_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata ?? {},
    ipAddress: row.ip_address ?? null,
    occurredAt: row.created_at,
  };
}

class PermissionHistoryIntegrationService {
  /**
   * @param {object}  [deps]
   * @param {import('../../../../domain/permission/registry/permission.registry').PermissionRegistry} [deps.registry]
   * @param {import('../history/permissionHistory.repository').PermissionHistoryRepository} [deps.historyRepository]
   */
  constructor({ registry = defaultRegistry, historyRepository = defaultHistoryRepository } = {}) {
    this._registry = registry;
    this._historyRepository = historyRepository;
  }

  /**
   * Read-only history timeline for one Permission, most recent first
   * unless `sort: 'asc'` is requested. Assignment and Governance events
   * appear together, unified, because both already write the same
   * `entity_id` (the Permission Identity) — see this file's header.
   *
   * @param {string} id — the Registry's internal Permission id (`:id` route param).
   * @param {object} [query]
   * @returns {Promise<{ permission: {id: string, identity: string}, items: object[], total: number } | null>}
   *   `null` when no Permission exists for `id` — the controller
   *   translates that to 404, mirroring permissionRegistry.controller.js's
   *   own `getPermissionById` convention.
   */
  async getHistoryForPermission(id, query = {}) {
    const entry = await this._registry.getPermission(id);
    if (!entry) return null;

    const { items, total } = await this._historyRepository.listPermissionHistory({
      ...query,
      entityId: entry.identity,
    });

    return {
      permission: { id: entry.id, identity: entry.identity },
      items: items.map(toHistoryEvent),
      total,
    };
  }

  /**
   * Read-only history timeline across every Permission — the
   * cross-Permission audit view (`GET /permissions/history`). Same
   * filters as the single-Permission timeline, minus the id -> identity
   * resolution (there is no single Permission to resolve).
   *
   * @param {object} [query]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async listHistory(query = {}) {
    const { items, total } = await this._historyRepository.listPermissionHistory(query);
    return { items: items.map(toHistoryEvent), total };
  }
}

module.exports = {
  PermissionHistoryIntegrationService,
  // Convenience singleton, matching this module's own
  // Assignment/Registry/Governance controller singleton convention.
  permissionHistoryIntegrationService: new PermissionHistoryIntegrationService(),
};
