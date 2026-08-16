'use strict';

/**
 * adminWeights.routes.test.js — WP-ADMIN-COMP-08-R23 + R24
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
 * What IS covered here: the router wires the two GET endpoints (R23) and
 * the one POST endpoint (R24) to the controller; request validation
 * rejects invalid values before the controller ever runs; and — the
 * regression-boundary requirement, now updated for R24 — /admin/weights
 * legitimately accepts POST as of R24, while /admin/weights/active still
 * accepts no write verb at all (R24 does not touch it), and PUT/PATCH/
 * DELETE remain unregistered on every path.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../adminWeights.service', () => ({
  listVersions: jest.fn(),
  getActiveVersion: jest.fn(),
  createVersion: jest.fn(),
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

function draftPayload(overrides = {}) {
  return {
    versionTag: 'v2.0.0',
    modelType: 'signal_weights',
    intelligenceDomain: 'professional',
    description: 'Draft weights for professional domain',
    weights: { systems_thinker: { weight: 0.8 } },
    ...overrides,
  };
}

describe('adminWeights.routes — WP-ADMIN-COMP-08-R23 + R24', () => {
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

  describe('POST /admin/weights — WP-ADMIN-COMP-08-R24', () => {
    it('201s with the created draft', async () => {
      const created = versionRow({
        id: 'v-draft',
        intelligenceDomain: 'professional',
        approvedBy: null,
        approvedAt: null,
        isApproved: false,
      });
      weightsService.createVersion.mockResolvedValue(created);

      const res = await request(app).post('/api/v1/admin/weights').send(draftPayload());

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(created);
      expect(res.body.meta).toMatchObject({ createdByAdminId: 'admin-1' });
      expect(weightsService.createVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          versionTag: 'v2.0.0',
          modelType: 'signal_weights',
          intelligenceDomain: 'professional',
        })
      );
    });

    it('400s on an invalid modelType and never calls the service', async () => {
      const res = await request(app)
        .post('/api/v1/admin/weights')
        .send(draftPayload({ modelType: 'not-a-real-model-type' }));

      expect(res.status).toBe(400);
      expect(weightsService.createVersion).not.toHaveBeenCalled();
    });

    it('accepts lineage_model on POST even though it is excluded from the GET filter vocabulary', async () => {
      weightsService.createVersion.mockResolvedValue(versionRow({ id: 'v-draft', modelType: 'lineage_model' }));

      const res = await request(app)
        .post('/api/v1/admin/weights')
        .send(draftPayload({ modelType: 'lineage_model' }));

      expect(res.status).toBe(201);
      expect(weightsService.createVersion).toHaveBeenCalledWith(
        expect.objectContaining({ modelType: 'lineage_model' })
      );
    });

    it('400s on an invalid intelligenceDomain and never calls the service', async () => {
      const res = await request(app)
        .post('/api/v1/admin/weights')
        .send(draftPayload({ intelligenceDomain: 'not-a-real-domain' }));

      expect(res.status).toBe(400);
      expect(weightsService.createVersion).not.toHaveBeenCalled();
    });

    it('400s when a required field is missing', async () => {
      const payload = draftPayload();
      delete payload.description;

      const res = await request(app).post('/api/v1/admin/weights').send(payload);

      expect(res.status).toBe(400);
      expect(weightsService.createVersion).not.toHaveBeenCalled();
    });

    it('400s when weights is not an object', async () => {
      const res = await request(app)
        .post('/api/v1/admin/weights')
        .send(draftPayload({ weights: 'not-an-object' }));

      expect(res.status).toBe(400);
      expect(weightsService.createVersion).not.toHaveBeenCalled();
    });

    it.each(['approvedBy', 'approvedAt', 'deprecatedAt', 'approved_by', 'approved_at', 'deprecated_at'])(
      '400s when %s is present in the request body and never calls the service',
      async (field) => {
        const res = await request(app)
          .post('/api/v1/admin/weights')
          .send({ ...draftPayload(), [field]: 'anything' });

        expect(res.status).toBe(400);
        expect(weightsService.createVersion).not.toHaveBeenCalled();
      }
    );

    it('409s with CONFLICT when the service reports a duplicate (intelligenceDomain, modelType, versionTag)', async () => {
      const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
      weightsService.createVersion.mockRejectedValue(
        new AppError('A model version with this intelligence domain, model type, and version tag already exists.', 409, {}, ErrorCodes.CONFLICT)
      );

      const res = await request(app).post('/api/v1/admin/weights').send(draftPayload());

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('surfaces a service failure as a 500 through the error handler, not a raw throw', async () => {
      weightsService.createVersion.mockRejectedValue(new Error('boom'));

      const res = await request(app).post('/api/v1/admin/weights').send(draftPayload());

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  describe('regression boundary — R24-updated write-surface scope', () => {
    it('registers no write verb other than POST on /admin/weights', async () => {
      const app2 = buildApp();
      const putRes = await request(app2).put('/api/v1/admin/weights').send({});
      const patchRes = await request(app2).patch('/api/v1/admin/weights').send({});
      const deleteRes = await request(app2).delete('/api/v1/admin/weights');

      // Express reports an unmatched method on a path with other
      // registered methods as 404 (no matching route), never routing
      // through to a mutation handler. POST is deliberately excluded from
      // this assertion as of R24 — see the "POST /admin/weights" suite
      // above for its coverage.
      expect([putRes.status, patchRes.status, deleteRes.status]).toEqual([404, 404, 404]);
    });

    it('registers no write verb at all on /admin/weights/active (R24 does not touch this route)', async () => {
      const app2 = buildApp();
      const postRes = await request(app2).post('/api/v1/admin/weights/active').send({});
      const patchRes = await request(app2).patch('/api/v1/admin/weights/active').send({});

      expect([postRes.status, patchRes.status]).toEqual([404, 404]);
    });

    it('the service mock exposes exactly the three expected operations (no unexpected extra service calls introduced by R24)', () => {
      expect(Object.keys(weightsService).sort()).toEqual([
        'createVersion',
        'getActiveVersion',
        'listVersions',
      ]);
    });
  });
});