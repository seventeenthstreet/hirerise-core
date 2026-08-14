'use strict';

/**
 * @file src/modules/admin/permissions/__tests__/permissionHistory.controller.test.js
 *
 * WP-ADMIN-05D — Enterprise Permission Audit & Governance History
 *
 * Controller-level test: the Permission History Integration Service is
 * mocked entirely — no Registry, no Repository, no Supabase. Exercises
 * only the transport layer's own responsibility: forwarding query
 * params and shaping the HTTP response, including the 404 translation
 * for an unresolvable Permission id.
 */

const { createPermissionHistoryController } = require('../controllers/permissionHistory.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides = {}) {
  return { params: {}, query: {}, body: {}, requestId: 'req-1', ...overrides };
}

describe('permissionHistory.controller', () => {
  let integrationService;
  let controller;
  let next;

  beforeEach(() => {
    integrationService = {
      getHistoryForPermission: jest.fn(),
      listHistory: jest.fn(),
    };
    controller = createPermissionHistoryController(integrationService);
    next = jest.fn();
  });

  describe('getHistoryForPermission', () => {
    it('returns 200 with the Integration Service result', async () => {
      const payload = { permission: { id: 'reg-1', identity: 'job_listing:view' }, items: [], total: 0 };
      integrationService.getHistoryForPermission.mockResolvedValue(payload);
      const req = makeReq({ params: { id: 'reg-1' }, query: { limit: '10', offset: '0' } });
      const res = makeRes();

      await controller.getHistoryForPermission(req, res, next);

      expect(integrationService.getHistoryForPermission).toHaveBeenCalledWith('reg-1', { limit: '10', offset: '0' });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: payload });
      expect(next).not.toHaveBeenCalled();
    });

    it('forwards only recognized query keys to the Integration Service', async () => {
      integrationService.getHistoryForPermission.mockResolvedValue({ permission: {}, items: [], total: 0 });
      const req = makeReq({
        params: { id: 'reg-1' },
        query: { action: 'PERMISSION_APPROVED', adminId: 'admin-1', dateFrom: '2026-08-01', dateTo: '2026-08-02', sort: 'asc', bogus: 'ignored' },
      });
      const res = makeRes();

      await controller.getHistoryForPermission(req, res, next);

      expect(integrationService.getHistoryForPermission).toHaveBeenCalledWith('reg-1', {
        action: 'PERMISSION_APPROVED',
        adminId: 'admin-1',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-02',
        sort: 'asc',
      });
    });

    it('returns 404 when the Integration Service resolves null (no Permission for id)', async () => {
      integrationService.getHistoryForPermission.mockResolvedValue(null);
      const req = makeReq({ params: { id: 'missing-id' } });
      const res = makeRes();

      await controller.getHistoryForPermission(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'PERMISSION_NOT_FOUND' }) }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('forwards an unexpected error to next()', async () => {
      const err = new Error('boom');
      integrationService.getHistoryForPermission.mockRejectedValue(err);
      const req = makeReq({ params: { id: 'reg-1' } });
      const res = makeRes();

      await controller.getHistoryForPermission(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe('listHistory', () => {
    it('returns 200 with the Integration Service result', async () => {
      const payload = { items: [], total: 0 };
      integrationService.listHistory.mockResolvedValue(payload);
      const req = makeReq({ query: { limit: '25' } });
      const res = makeRes();

      await controller.listHistory(req, res, next);

      expect(integrationService.listHistory).toHaveBeenCalledWith({ limit: '25' });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: payload });
    });

    it('forwards an unexpected error to next()', async () => {
      const err = new Error('boom');
      integrationService.listHistory.mockRejectedValue(err);
      const req = makeReq();
      const res = makeRes();

      await controller.listHistory(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
