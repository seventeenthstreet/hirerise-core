'use strict';

/**
 * @file adminWeights.routes.authorization.test.js
 *
 * WP-ADMIN-COMP-08-R27 — Intelligence Model/Version Governance
 * Authorization Correction.
 *
 * A live negative-path test found that an authenticated user with
 * app_metadata.role = "admin" who is NOT MASTER_ADMIN could create,
 * approve, and deprecate model versions — the mutation routes carried no
 * route-level authorization beyond the mount-level `requireAdmin` chain.
 * This suite exists specifically to pin the authorization placement that
 * correction added, following the exact convention of
 * administrators.routes.authorization.test.js: real router + real
 * requireMasterAdmin middleware + a stub that injects req.user, service
 * layer mocked out.
 *
 * requireAdmin itself is NOT exercised here — it is applied at the
 * server.js mount point (not by this router in isolation) and has its own
 * dedicated suite (requireAdmin.middleware.test.js). Only
 * requireMasterAdmin's route-level placement on the three mutation routes
 * is under test here. GET /admin/weights and GET /admin/weights/active
 * are intentionally out of scope for this matrix — they remain
 * requireAdmin-only and were not part of the confirmed defect.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../adminWeights.service', () => ({
  listVersions: jest.fn(),
  getActiveVersion: jest.fn(),
  createVersion: jest.fn(() => Promise.resolve({ id: 'v-1' })),
  approveVersion: jest.fn(() => Promise.resolve({ id: 'v-1' })),
  deprecateVersion: jest.fn(() => Promise.resolve({ id: 'v-1' })),
}));

const weightsService = require('../adminWeights.service');
const weightsRoutes = require('../adminWeights.routes');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  // Stands in for `authenticate` — the real requireMasterAdmin only reads
  // req.user, so this is sufficient to test its placement without pulling
  // in the real auth stack (out of scope for this correction).
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/v1/admin/weights', weightsRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

const versionId = '11111111-1111-4111-8111-111111111111';
const draftPayload = {
  versionTag: 'v2.0.0',
  modelType: 'signal_weights',
  intelligenceDomain: 'professional',
  description: 'Draft weights for professional domain',
  weights: { systems_thinker: { weight: 0.8 } },
};

// Authenticated, role = admin, explicitly NOT MASTER_ADMIN — the exact
// negative-path identity the live finding required, not an anonymous or
// unauthenticated caller.
const ADMIN_USER = { uid: 'admin-1', id: 'admin-1', role: 'admin' };
const MASTER_ADMIN_USER = { uid: 'master-1', id: 'master-1', role: 'MASTER_ADMIN' };

describe('adminWeights.routes — WP-ADMIN-COMP-08-R27 authorization placement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('ordinary ADMIN (authenticated, role=admin, not MASTER_ADMIN) — denied', () => {
    it('POST /admin/weights — 403 FORBIDDEN, service never called', async () => {
      const app = buildApp(ADMIN_USER);

      const res = await request(app).post('/api/v1/admin/weights').send(draftPayload);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(weightsService.createVersion).not.toHaveBeenCalled();
    });

    it('POST /admin/weights/:id/approve — 403 FORBIDDEN, service never called', async () => {
      const app = buildApp(ADMIN_USER);

      const res = await request(app)
        .post(`/api/v1/admin/weights/${versionId}/approve`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(weightsService.approveVersion).not.toHaveBeenCalled();
    });

    it('POST /admin/weights/:id/deprecate — 403 FORBIDDEN, service never called', async () => {
      const app = buildApp(ADMIN_USER);

      const res = await request(app)
        .post(`/api/v1/admin/weights/${versionId}/deprecate`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(weightsService.deprecateVersion).not.toHaveBeenCalled();
    });
  });

  describe('ordinary ADMIN — GET routes remain allowed (unaffected by this correction)', () => {
    it('GET /admin/weights — 200', async () => {
      weightsService.listVersions.mockResolvedValue({ items: [] });
      const app = buildApp(ADMIN_USER);

      const res = await request(app).get('/api/v1/admin/weights');

      expect(res.status).toBe(200);
    });

    it('GET /admin/weights/active — 200', async () => {
      weightsService.getActiveVersion.mockResolvedValue({ id: 'v-active' });
      const app = buildApp(ADMIN_USER);

      const res = await request(app).get('/api/v1/admin/weights/active');

      expect(res.status).toBe(200);
    });
  });

  describe('MASTER_ADMIN — every mutation allowed', () => {
    it('POST /admin/weights — 201', async () => {
      weightsService.createVersion.mockResolvedValue({ id: 'v-draft' });
      const app = buildApp(MASTER_ADMIN_USER);

      const res = await request(app).post('/api/v1/admin/weights').send(draftPayload);

      expect(res.status).toBe(201);
      expect(weightsService.createVersion).toHaveBeenCalled();
    });

    it('POST /admin/weights/:id/approve — 200', async () => {
      weightsService.approveVersion.mockResolvedValue({ id: versionId });
      const app = buildApp(MASTER_ADMIN_USER);

      const res = await request(app)
        .post(`/api/v1/admin/weights/${versionId}/approve`)
        .send();

      expect(res.status).toBe(200);
      expect(weightsService.approveVersion).toHaveBeenCalledWith(versionId, 'master-1');
    });

    it('POST /admin/weights/:id/deprecate — 200', async () => {
      weightsService.deprecateVersion.mockResolvedValue({ id: versionId });
      const app = buildApp(MASTER_ADMIN_USER);

      const res = await request(app)
        .post(`/api/v1/admin/weights/${versionId}/deprecate`)
        .send();

      expect(res.status).toBe(200);
      expect(weightsService.deprecateVersion).toHaveBeenCalledWith(versionId, 'master-1');
    });
  });
});
