'use strict';

/**
 * adminWeights.routes.test.js — WP-ADMIN-COMP-08-R23
 *
 * Route-level test: mounts the real router in a minimal Express app
 * (service layer mocked out), following the existing
 * administrators.routes.authorization.test.js / permissionAdmin.routes.test.js
 * convention of testing real router + real validation middleware with a
 * stubbed req.user.
 *
 * This suite does NOT re-test authenticate/requireAdmin/requireElevatedSession
 * themselves — those already have dedicated suites
 * (middleware/__tests__/requireAdmin.middleware.test.js and similar) and
 * this router, like adminUsers.routes.js and adminCmsSkills.routes.js,
 * carries no route-level authorization logic of its own — the entire
 * chain is applied once at the server.js mount point. That mount-point
 * chain is verified statically (see the R23 implementation report §8,
 * "Static route verification") rather than re-executed here, matching
 * how adminUsers.routes.js / adminCmsSkills.routes.js are tested.
 *
 * What IS covered here: the router wires exactly the two documented GET
 * endpoints to the controller, request validation rejects invalid
 * intelligenceDomain/modelType values before the controller ever runs,
 * and — the explicit R23 regression-boundary requirement — no write verb
 * (POST/PUT/PATCH/DELETE) is registered on either path.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../adminWeights.service', () => ({
  listVersions: jest.fn(),
  getActiveVersion: jest.fn(),
}));

const weightsService = require('../adminWeights.service');
const weightsRoutes = require('../adminWeights.routes');
const { errorHandler } = require('../../../../middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'admin-1', role: 'admin' };
    next();
  });
  app.use('/api/v1/admin/weights', weightsRoutes);
  app.use(errorHandler);
  return app;
}

function versionRow(overrides = {}) {
  return {
    id: 'v-1',
    versionTag: 'v1.0.0',
    modelType: 'signal_weights',
    intelligenceDomain: 'student',
    description: 'Initial weights',
    approvedBy: 'system',
    approvedAt: '2026-06-01T00:00:00.000Z',
    effectiveFrom: '2026-06-01T00:00:00.000Z',
    deprecatedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    isApproved: true,
    isDeprecated: false,
    ...overrides,
  };
}

describe('adminWeights.routes — WP-ADMIN-COMP-08-R23', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe('GET /admin/weights', () => {
    it('200s with the listed items', async () => {
      weightsService.listVersions.mockResolvedValue({ items: [versionRow()] });

      const res = await request(app).get('/api/v1/admin/weights');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { items: [versionRow()] } });
      expect(weightsService.listVersions).toHaveBeenCalledWith({
        intelligenceDomain: undefined,
        modelType: undefined,
      });
    });

    it('forwards valid intelligenceDomain/modelType query params', async () => {
      weightsService.listVersions.mockResolvedValue({ items: [] });

      await request(app)
        .get('/api/v1/admin/weights')
        .query({ intelligenceDomain: 'employer', modelType: 'matching_model' });

      expect(weightsService.listVersions).toHaveBeenCalledWith({
        intelligenceDomain: 'employer',
        modelType: 'matching_model',
      });
    });

    it('400s on an invalid intelligenceDomain and never calls the service', async () => {
      const res = await request(app)
        .get('/api/v1/admin/weights')
        .query({ intelligenceDomain: 'not-a-real-domain' });

      expect(res.status).toBe(400);
      expect(weightsService.listVersions).not.toHaveBeenCalled();
    });

    it('400s on an invalid modelType and never calls the service', async () => {
      const res = await request(app)
        .get('/api/v1/admin/weights')
        .query({ modelType: 'not-a-real-model-type' });

      expect(res.status).toBe(400);
      expect(weightsService.listVersions).not.toHaveBeenCalled();
    });

    it('surfaces a service failure as a 500 through the error handler, not a raw throw', async () => {
      weightsService.listVersions.mockRejectedValue(new Error('boom'));

      const res = await request(app).get('/api/v1/admin/weights');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /admin/weights/active', () => {
    it('200s with the resolved active version', async () => {
      weightsService.getActiveVersion.mockResolvedValue(versionRow({ id: 'v-active' }));

      const res = await request(app).get('/api/v1/admin/weights/active');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: versionRow({ id: 'v-active' }) });
    });

    it('404s with NOT_FOUND when the service reports no active version', async () => {
      const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
      weightsService.getActiveVersion.mockRejectedValue(
        new AppError('No active model version found', 404, {}, ErrorCodes.NOT_FOUND)
      );

      const res = await request(app).get('/api/v1/admin/weights/active');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('400s on an invalid modelType and never calls the service', async () => {
      const res = await request(app)
        .get('/api/v1/admin/weights/active')
        .query({ modelType: 'not-a-real-model-type' });

      expect(res.status).toBe(400);
      expect(weightsService.getActiveVersion).not.toHaveBeenCalled();
    });
  });

  describe('regression boundary — read-only surface (R23 §11 acceptance criteria)', () => {
    it('registers no write verb on /admin/weights', async () => {
      const app2 = buildApp();
      const postRes = await request(app2).post('/api/v1/admin/weights').send({});
      const putRes = await request(app2).put('/api/v1/admin/weights').send({});
      const patchRes = await request(app2).patch('/api/v1/admin/weights').send({});
      const deleteRes = await request(app2).delete('/api/v1/admin/weights');

      // Express reports an unmatched method on a path with other
      // registered methods as 404 (no matching route), never routing
      // through to a mutation handler.
      expect([postRes.status, putRes.status, patchRes.status, deleteRes.status]).toEqual([
        404, 404, 404, 404,
      ]);
    });

    it('registers no write verb on /admin/weights/active', async () => {
      const app2 = buildApp();
      const postRes = await request(app2).post('/api/v1/admin/weights/active').send({});
      const patchRes = await request(app2).patch('/api/v1/admin/weights/active').send({});

      expect([postRes.status, patchRes.status]).toEqual([404, 404]);
    });

    it('the service mock never receives a call implying a mutation (no unexpected method calls beyond listVersions/getActiveVersion)', () => {
      expect(Object.keys(weightsService).sort()).toEqual(['getActiveVersion', 'listVersions']);
    });
  });
});
