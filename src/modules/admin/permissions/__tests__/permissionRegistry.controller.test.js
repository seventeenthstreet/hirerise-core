'use strict';

/**
 * @file src/modules/admin/permissions/__tests__/permissionRegistry.controller.test.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Controller-level test: the certified Permission Registry
 * (WP-ADMIN-04F-03) is mocked entirely — no Supabase, no repository, no
 * end-to-end request. This exercises only the transport layer's own
 * responsibility: forwarding to the Registry and shaping the HTTP
 * response, including its own error translation.
 */

const { createPermissionRegistryController } = require('../controllers/permissionRegistry.controller');
const { PermissionRegistryValidationError } = require('../../../../domain/permission/registry/permission.registry.errors');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides = {}) {
  return { params: {}, query: {}, body: {}, requestId: 'req-1', ...overrides };
}

describe('permissionRegistry.controller', () => {
  let registry;
  let controller;
  let next;

  beforeEach(() => {
    registry = {
      listPermissions: jest.fn(),
      getPermission: jest.fn(),
      getPermissionByIdentity: jest.fn(),
      findByResource: jest.fn(),
      findByAction: jest.fn(),
      findByCategory: jest.fn(),
    };
    controller = createPermissionRegistryController(registry);
    next = jest.fn();
  });

  describe('listPermissions', () => {
    it('returns 200 with the Registry result', async () => {
      registry.listPermissions.mockResolvedValue({ items: [{ id: 'p-1' }], total: 1 });
      const req = makeReq({ query: { limit: 10, offset: 0 } });
      const res = makeRes();

      await controller.listPermissions(req, res, next);

      expect(registry.listPermissions).toHaveBeenCalledWith({ limit: 10, offset: 0 });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { items: [{ id: 'p-1' }], total: 1 } });
      expect(next).not.toHaveBeenCalled();
    });

    it('forwards an unrecognized Registry error to next()', async () => {
      const boom = new Error('unexpected');
      registry.listPermissions.mockRejectedValue(boom);
      const res = makeRes();

      await controller.listPermissions(makeReq(), res, next);

      expect(next).toHaveBeenCalledWith(boom);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('translates a PermissionRegistryValidationError into a 400 canonical response', async () => {
      registry.listPermissions.mockRejectedValue(
        new PermissionRegistryValidationError('limit must be a positive integer')
      );
      const res = makeRes();

      await controller.listPermissions(makeReq(), res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'PERMISSION_REGISTRY_VALIDATION_ERROR' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('getPermissionById', () => {
    it('returns 200 with the entry when found', async () => {
      registry.getPermission.mockResolvedValue({ id: 'p-1', identity: 'job_listing:view' });
      const req = makeReq({ params: { id: 'p-1' } });
      const res = makeRes();

      await controller.getPermissionById(req, res, next);

      expect(registry.getPermission).toHaveBeenCalledWith('p-1');
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'p-1', identity: 'job_listing:view' } });
    });

    it('returns 404 for a missing Permission', async () => {
      registry.getPermission.mockResolvedValue(null);
      const req = makeReq({ params: { id: 'does-not-exist' } });
      const res = makeRes();

      await controller.getPermissionById(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'PERMISSION_NOT_FOUND' }) })
      );
    });
  });

  describe('getPermissionByIdentity', () => {
    it('returns 404 for a missing identity', async () => {
      registry.getPermissionByIdentity.mockResolvedValue(null);
      const req = makeReq({ params: { identity: 'job_listing:view' } });
      const res = makeRes();

      await controller.getPermissionByIdentity(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 200 with the entry when found', async () => {
      registry.getPermissionByIdentity.mockResolvedValue({ id: 'p-1', identity: 'job_listing:view' });
      const req = makeReq({ params: { identity: 'job_listing:view' } });
      const res = makeRes();

      await controller.getPermissionByIdentity(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'p-1', identity: 'job_listing:view' } });
    });
  });

  describe('findByResource / findByAction / findByCategory', () => {
    it('findByResource forwards the resource param and pagination', async () => {
      registry.findByResource.mockResolvedValue({ items: [], total: 0 });
      const req = makeReq({ params: { resource: 'job_listing' }, query: { limit: 5 } });
      const res = makeRes();

      await controller.findByResource(req, res, next);

      expect(registry.findByResource).toHaveBeenCalledWith('job_listing', { limit: 5 });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { items: [], total: 0 } });
    });

    it('findByAction forwards the action param', async () => {
      registry.findByAction.mockResolvedValue({ items: [], total: 0 });
      const req = makeReq({ params: { action: 'view' } });
      const res = makeRes();

      await controller.findByAction(req, res, next);

      expect(registry.findByAction).toHaveBeenCalledWith('view', {});
    });

    it('findByCategory forwards the category param', async () => {
      registry.findByCategory.mockResolvedValue({ items: [], total: 0 });
      const req = makeReq({ params: { category: 'jobs' } });
      const res = makeRes();

      await controller.findByCategory(req, res, next);

      expect(registry.findByCategory).toHaveBeenCalledWith('jobs', {});
    });
  });

  // WP-ADMIN-04F-13B — assignableOnly is transport-layer post-filtering
  // built on top of the certified Assignment Policy (PUBLISHED/ADOPTED),
  // never a re-implementation of it. See permissionRegistry.controller.js.
  describe('assignableOnly filtering', () => {
    const mixedItems = [
      { id: 'p-proposed', status: 'proposed' },
      { id: 'p-published', status: 'published' },
      { id: 'p-adopted', status: 'adopted' },
      { id: 'p-deprecated', status: 'deprecated' },
      { id: 'p-retired', status: 'retired' },
    ];

    it('listPermissions omitted assignableOnly returns every item unchanged', async () => {
      registry.listPermissions.mockResolvedValue({ items: mixedItems, total: mixedItems.length });
      const req = makeReq({ query: {} });
      const res = makeRes();

      await controller.listPermissions(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { items: mixedItems, total: mixedItems.length } });
    });

    it('listPermissions with assignableOnly=true narrows to PUBLISHED/ADOPTED and adjusts total', async () => {
      registry.listPermissions.mockResolvedValue({ items: mixedItems, total: mixedItems.length });
      const req = makeReq({ query: { assignableOnly: true } });
      const res = makeRes();

      await controller.listPermissions(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { items: [mixedItems[1], mixedItems[2]], total: 2 },
      });
    });

    it('a falsy/non-true assignableOnly value (post-validation coercion only yields real booleans) is a no-op', async () => {
      registry.listPermissions.mockResolvedValue({ items: mixedItems, total: mixedItems.length });
      const req = makeReq({ query: { assignableOnly: false } });
      const res = makeRes();

      await controller.listPermissions(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { items: mixedItems, total: mixedItems.length } });
    });

    it('findByResource with assignableOnly=true narrows the Registry result the same way', async () => {
      registry.findByResource.mockResolvedValue({ items: mixedItems, total: mixedItems.length });
      const req = makeReq({ params: { resource: 'job_listing' }, query: { assignableOnly: true } });
      const res = makeRes();

      await controller.findByResource(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { items: [mixedItems[1], mixedItems[2]], total: 2 },
      });
    });
  });
});
