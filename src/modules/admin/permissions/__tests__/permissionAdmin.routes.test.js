'use strict';

/**
 * @file src/modules/admin/permissions/__tests__/permissionAdmin.routes.test.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Route-level test: mounts the real router in a minimal Express app (no
 * server.js involved). The certified Authorization Middleware
 * (WP-ADMIN-04F-07) is mocked to a permissive pass-through here — its
 * own Allow/Deny behavior already has dedicated coverage in
 * `src/domain/permission/middleware/permission.middleware.test.js`; this
 * file only verifies that this WP's routes are wired to the right
 * controller methods with the right validation, matching the existing
 * `decision.routes.test.js` convention for route-level tests in this
 * codebase.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../../../domain/permission/middleware/permission.middleware', () => ({
  requirePermission: () => (req, res, next) => next(),
}));

const mockRegistryController = {
  listPermissions: jest.fn((req, res) => res.json({ success: true, data: { items: [], total: 0 } })),
  getPermissionById: jest.fn((req, res) => res.json({ success: true, data: { id: req.params.id } })),
  getPermissionByIdentity: jest.fn((req, res) => res.json({ success: true, data: { identity: req.params.identity } })),
  findByResource: jest.fn((req, res) => res.json({ success: true, data: { items: [], total: 0 } })),
  findByAction: jest.fn((req, res) => res.json({ success: true, data: { items: [], total: 0 } })),
  findByCategory: jest.fn((req, res) => res.json({ success: true, data: { items: [], total: 0 } })),
};

const mockAssignmentController = {
  assignPermission: jest.fn((req, res) => res.status(201).json({ success: true, data: { assigned: true } })),
  revokePermission: jest.fn((req, res) => res.json({ success: true, data: { revoked: true } })),
  checkAssignment: jest.fn((req, res) => res.json({ success: true, data: { assigned: false } })),
  listAssignments: jest.fn((req, res) => res.json({ success: true, data: { assignments: [] } })),
  getAssignmentsForPrincipal: jest.fn((req, res) => res.json({ success: true, data: { assignments: [] } })),
};

const mockEvaluationController = {
  evaluate: jest.fn((req, res) => res.json({ success: true, data: { decision: { outcome: 'ALLOW' } } })),
};

// WP-ADMIN-05D — Enterprise Permission Audit & Governance History.
const mockHistoryController = {
  getHistoryForPermission: jest.fn((req, res) =>
    res.json({ success: true, data: { permission: { id: req.params.id }, items: [], total: 0 } }),
  ),
  listHistory: jest.fn((req, res) => res.json({ success: true, data: { items: [], total: 0 } })),
};

jest.mock('../controllers/permissionRegistry.controller', () => ({
  permissionRegistryController: mockRegistryController,
}));
jest.mock('../controllers/permissionAssignment.controller', () => ({
  permissionAssignmentController: mockAssignmentController,
}));
jest.mock('../controllers/permissionEvaluation.controller', () => ({
  permissionEvaluationController: mockEvaluationController,
}));
jest.mock('../controllers/permissionHistory.controller', () => ({
  permissionHistoryController: mockHistoryController,
}));

const permissionAdminRoutes = require('../routes/permissionAdmin.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/permissions', permissionAdminRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('permissionAdmin.routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('GET /registry routes to listPermissions', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/registry');
    expect(res.status).toBe(200);
    expect(mockRegistryController.listPermissions).toHaveBeenCalledTimes(1);
  });

  it('GET /registry rejects an out-of-range limit with a 400 before reaching the controller', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/registry').query({ limit: 999 });
    expect(res.status).toBe(400);
    expect(mockRegistryController.listPermissions).not.toHaveBeenCalled();
  });

  it('GET /registry accepts assignableOnly=true and forwards to listPermissions', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/registry').query({ assignableOnly: 'true' });
    expect(res.status).toBe(200);
    expect(mockRegistryController.listPermissions).toHaveBeenCalledTimes(1);
  });

  it('GET /registry rejects a non-boolean assignableOnly with a 400 before reaching the controller', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/registry').query({ assignableOnly: 'not-a-boolean' });
    expect(res.status).toBe(400);
    expect(mockRegistryController.listPermissions).not.toHaveBeenCalled();
  });

  it('GET /registry/resource/:resource routes to findByResource', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/registry/resource/job_listing');
    expect(res.status).toBe(200);
    expect(mockRegistryController.findByResource).toHaveBeenCalledTimes(1);
  });

  it('GET /registry/resource/:resource accepts assignableOnly=true', async () => {
    const res = await request(app)
      .get('/api/v1/admin/permissions/registry/resource/job_listing')
      .query({ assignableOnly: 'true' });
    expect(res.status).toBe(200);
    expect(mockRegistryController.findByResource).toHaveBeenCalledTimes(1);
  });

  it('GET /registry/:id routes to getPermissionById (after the more specific routes)', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/registry/p-1');
    expect(res.status).toBe(200);
    expect(mockRegistryController.getPermissionById).toHaveBeenCalledTimes(1);
  });

  it('POST /assignments routes to assignPermission and rejects a missing field with a 400', async () => {
    const ok = await request(app)
      .post('/api/v1/admin/permissions/assignments')
      .send({ principalId: 'u1', resource: 'job_listing', action: 'view' });
    expect(ok.status).toBe(201);
    expect(mockAssignmentController.assignPermission).toHaveBeenCalledTimes(1);

    const bad = await request(app)
      .post('/api/v1/admin/permissions/assignments')
      .send({ resource: 'job_listing', action: 'view' });
    expect(bad.status).toBe(400);
    expect(mockAssignmentController.assignPermission).toHaveBeenCalledTimes(1);
  });

  it('DELETE /assignments routes to revokePermission', async () => {
    const res = await request(app)
      .delete('/api/v1/admin/permissions/assignments')
      .send({ principalId: 'u1', resource: 'job_listing', action: 'view' });
    expect(res.status).toBe(200);
    expect(mockAssignmentController.revokePermission).toHaveBeenCalledTimes(1);
  });

  it('GET /assignments/check routes to checkAssignment', async () => {
    const res = await request(app)
      .get('/api/v1/admin/permissions/assignments/check')
      .query({ principalId: 'u1', resource: 'job_listing', action: 'view' });
    expect(res.status).toBe(200);
    expect(mockAssignmentController.checkAssignment).toHaveBeenCalledTimes(1);
  });

  it('GET /assignments/principal/:principalId routes to getAssignmentsForPrincipal', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/assignments/principal/u1');
    expect(res.status).toBe(200);
    expect(mockAssignmentController.getAssignmentsForPrincipal).toHaveBeenCalledTimes(1);
  });

  it('POST /evaluate routes to evaluate and rejects a missing field with a 400', async () => {
    const ok = await request(app)
      .post('/api/v1/admin/permissions/evaluate')
      .send({ principalId: 'u1', resource: 'job_listing', action: 'view' });
    expect(ok.status).toBe(200);
    expect(mockEvaluationController.evaluate).toHaveBeenCalledTimes(1);

    const bad = await request(app)
      .post('/api/v1/admin/permissions/evaluate')
      .send({ principalId: 'u1', action: 'view' });
    expect(bad.status).toBe(400);
    expect(mockEvaluationController.evaluate).toHaveBeenCalledTimes(1);
  });

  // WP-ADMIN-05D — Enterprise Permission Audit & Governance History.
  it('GET /history routes to listHistory', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/history');
    expect(res.status).toBe(200);
    expect(mockHistoryController.listHistory).toHaveBeenCalledTimes(1);
  });

  it('GET /history rejects an out-of-range limit with a 400 before reaching the controller', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/history').query({ limit: 999 });
    expect(res.status).toBe(400);
    expect(mockHistoryController.listHistory).not.toHaveBeenCalled();
  });

  it('GET /history rejects an invalid sort value with a 400 before reaching the controller', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/history').query({ sort: 'sideways' });
    expect(res.status).toBe(400);
    expect(mockHistoryController.listHistory).not.toHaveBeenCalled();
  });

  it('GET /history rejects a malformed dateFrom with a 400 before reaching the controller', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/history').query({ dateFrom: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(mockHistoryController.listHistory).not.toHaveBeenCalled();
  });

  it('GET /:id/history routes to getHistoryForPermission (not swallowed by /:id/approve etc.)', async () => {
    const res = await request(app).get('/api/v1/admin/permissions/p-1/history');
    expect(res.status).toBe(200);
    expect(mockHistoryController.getHistoryForPermission).toHaveBeenCalledTimes(1);
  });

  it('GET /:id/history accepts filter/sort/pagination query params', async () => {
    const res = await request(app)
      .get('/api/v1/admin/permissions/p-1/history')
      .query({ action: 'PERMISSION_APPROVED', adminId: 'admin-1', sort: 'asc', limit: 20, offset: 0 });
    expect(res.status).toBe(200);
    expect(mockHistoryController.getHistoryForPermission).toHaveBeenCalledTimes(1);
  });

  it('GET /:id/history rejects a blank id with a 400 before reaching the controller', async () => {
    // A literal blank :id segment isn't reachable via a normal URL (it
    // would collapse to /history, matching the global route instead) —
    // this exercises the same "id is required" validator the Governance
    // transition routes already share, for parity, via an
    // otherwise-well-formed request whose id the validator still trims
    // to empty.
    const res = await request(app).get('/api/v1/admin/permissions/%20/history');
    expect(res.status).toBe(400);
    expect(mockHistoryController.getHistoryForPermission).not.toHaveBeenCalled();
  });
});
