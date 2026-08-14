'use strict';

/**
 * @file src/modules/admin/permissions/services/__tests__/permissionHistory.integration.test.js
 *
 * WP-ADMIN-05D — Enterprise Permission Audit & Governance History
 *
 * Service-level test: the certified Permission Registry and this WP's
 * own PermissionHistoryRepository are both mocked entirely — no
 * Supabase, no HTTP. Exercises only this service's own responsibility:
 * id -> identity resolution and DTO mapping, per the certified
 * architecture's "no business logic" boundary.
 */

const { PermissionHistoryIntegrationService } = require('../permissionHistory.integration');

function makeRow(overrides = {}) {
  return {
    id: 'log-1',
    admin_id: 'admin-1',
    action: 'PERMISSION_ASSIGNED',
    entity_type: 'permission',
    entity_id: 'job_listing:view',
    metadata: { principalId: 'u1' },
    ip_address: '203.0.113.9',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PermissionHistoryIntegrationService', () => {
  let registry;
  let historyRepository;
  let service;

  beforeEach(() => {
    registry = { getPermission: jest.fn() };
    historyRepository = { listPermissionHistory: jest.fn() };
    service = new PermissionHistoryIntegrationService({ registry, historyRepository });
  });

  describe('getHistoryForPermission', () => {
    it('resolves id -> identity via the Registry, then queries by that identity', async () => {
      registry.getPermission.mockResolvedValue({ id: 'reg-1', identity: 'job_listing:view' });
      historyRepository.listPermissionHistory.mockResolvedValue({ items: [makeRow()], total: 1 });

      const result = await service.getHistoryForPermission('reg-1', { limit: 10 });

      expect(registry.getPermission).toHaveBeenCalledWith('reg-1');
      expect(historyRepository.listPermissionHistory).toHaveBeenCalledWith({
        limit: 10,
        entityId: 'job_listing:view',
      });
      expect(result.permission).toEqual({ id: 'reg-1', identity: 'job_listing:view' });
      expect(result.total).toBe(1);
    });

    it('maps each raw admin_logs row to the timeline event DTO shape', async () => {
      registry.getPermission.mockResolvedValue({ id: 'reg-1', identity: 'job_listing:view' });
      historyRepository.listPermissionHistory.mockResolvedValue({ items: [makeRow()], total: 1 });

      const result = await service.getHistoryForPermission('reg-1');

      expect(result.items[0]).toEqual({
        id: 'log-1',
        action: 'PERMISSION_ASSIGNED',
        adminId: 'admin-1',
        entityType: 'permission',
        entityId: 'job_listing:view',
        metadata: { principalId: 'u1' },
        ipAddress: '203.0.113.9',
        occurredAt: '2026-08-01T00:00:00.000Z',
      });
    });

    it('defaults metadata to {} and ipAddress to null when absent from the row', async () => {
      registry.getPermission.mockResolvedValue({ id: 'reg-1', identity: 'job_listing:view' });
      historyRepository.listPermissionHistory.mockResolvedValue({
        items: [makeRow({ metadata: null, ip_address: null })],
        total: 1,
      });

      const result = await service.getHistoryForPermission('reg-1');

      expect(result.items[0].metadata).toEqual({});
      expect(result.items[0].ipAddress).toBeNull();
    });

    it('returns null (never calls the repository) when the Registry has no Permission for id', async () => {
      registry.getPermission.mockResolvedValue(null);

      const result = await service.getHistoryForPermission('missing-id');

      expect(result).toBeNull();
      expect(historyRepository.listPermissionHistory).not.toHaveBeenCalled();
    });

    it('unifies Assignment and Governance events in one ordered response — no separate merge step', async () => {
      registry.getPermission.mockResolvedValue({ id: 'reg-1', identity: 'job_listing:view' });
      historyRepository.listPermissionHistory.mockResolvedValue({
        items: [
          makeRow({ id: 'log-2', action: 'PERMISSION_APPROVED' }),
          makeRow({ id: 'log-1', action: 'PERMISSION_ASSIGNED' }),
        ],
        total: 2,
      });

      const result = await service.getHistoryForPermission('reg-1');

      // Ordering is the Repository's responsibility (already verified by
      // permissionHistory.repository.test.js) — this asserts only that
      // the Integration Service passes the Repository's order through
      // unchanged, introducing no second sort/merge step of its own.
      expect(result.items.map((e) => e.action)).toEqual(['PERMISSION_APPROVED', 'PERMISSION_ASSIGNED']);
    });
  });

  describe('listHistory', () => {
    it('queries the Repository directly with no id resolution', async () => {
      historyRepository.listPermissionHistory.mockResolvedValue({ items: [makeRow()], total: 1 });

      const result = await service.listHistory({ action: 'PERMISSION_ASSIGNED' });

      expect(registry.getPermission).not.toHaveBeenCalled();
      expect(historyRepository.listPermissionHistory).toHaveBeenCalledWith({ action: 'PERMISSION_ASSIGNED' });
      expect(result.total).toBe(1);
      expect(result.items[0].action).toBe('PERMISSION_ASSIGNED');
    });
  });
});
