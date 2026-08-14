'use strict';

/**
 * @file administrators.routes.authorization.test.js
 *
 * WP-ADMIN-05A-R1 — Enterprise Administrator Management Authorization
 * Reconciliation.
 *
 * Route-level test: mounts the real router in a minimal Express app,
 * following the existing `permissionAdmin.routes.test.js` convention
 * (real router + real requireMasterAdmin middleware + a stub that injects
 * req.user, service layer mocked out). This test exists specifically to
 * pin the authorization placement this WP changed — it does not
 * re-verify controller/service behaviour, which is already covered by
 * administrators.service.test.js.
 *
 * requireAdmin itself is NOT exercised here (it does its own DB
 * verification and has its own dedicated test suite,
 * requireAdmin.middleware.test.js) — this router is mounted directly, so
 * only requireMasterAdmin's route-level placement is under test. That
 * matches how this reconciliation was scoped: authorization *placement*,
 * not the middleware implementations themselves.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../administrators.service', () => ({
  listAdministrators: jest.fn(() => Promise.resolve({ administrators: [], total: 0 })),
  getAdministrator: jest.fn(() => Promise.resolve({ uid: 'target-1' })),
  grantAdministrator: jest.fn(() => Promise.resolve({ uid: 'target-1' })),
  suspendAdministrator: jest.fn(() => Promise.resolve({ uid: 'target-1' })),
  reactivateAdministrator: jest.fn(() => Promise.resolve({ uid: 'target-1' })),
  revokeAdministrator: jest.fn(() => Promise.resolve({ uid: 'target-1' })),
}));

const administratorsRoutes = require('../administrators.routes');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  // Stands in for `authenticate` — the real requireMasterAdmin only reads
  // req.user, so this is sufficient to test its placement without pulling
  // in the real auth stack (out of scope for this reconciliation).
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/v1/admin/administrators', administratorsRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

const ADMIN_USER = { uid: 'admin-1', id: 'admin-1', role: 'admin' };
const MASTER_ADMIN_USER = { uid: 'master-1', id: 'master-1', role: 'MASTER_ADMIN' };

describe('administrators.routes — WP-ADMIN-05A-R1 authorization placement', () => {
  describe('ADMIN (non-MASTER_ADMIN) — allowed', () => {
    const app = buildApp(ADMIN_USER);

    it('GET / — 200', async () => {
      const res = await request(app).get('/api/v1/admin/administrators');
      expect(res.status).toBe(200);
    });

    it('GET /:uid — 200', async () => {
      const res = await request(app).get('/api/v1/admin/administrators/target-1');
      expect(res.status).toBe(200);
    });

    it('POST /:uid/suspend — 200', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/suspend').send({});
      expect(res.status).toBe(200);
    });

    it('POST /:uid/reactivate — 200', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/reactivate').send({});
      expect(res.status).toBe(200);
    });
  });

  describe('ADMIN (non-MASTER_ADMIN) — forbidden', () => {
    const app = buildApp(ADMIN_USER);

    it('POST /:uid/grant — 403 FORBIDDEN', async () => {
      const res = await request(app)
        .post('/api/v1/admin/administrators/target-1/grant')
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('POST /:uid/revoke — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/revoke').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('MASTER_ADMIN — every operation allowed', () => {
    const app = buildApp(MASTER_ADMIN_USER);

    it('GET / — 200', async () => {
      expect((await request(app).get('/api/v1/admin/administrators')).status).toBe(200);
    });

    it('GET /:uid — 200', async () => {
      expect((await request(app).get('/api/v1/admin/administrators/target-1')).status).toBe(200);
    });

    it('POST /:uid/grant — 200', async () => {
      const res = await request(app)
        .post('/api/v1/admin/administrators/target-1/grant')
        .send({ role: 'admin' });
      expect(res.status).toBe(200);
    });

    it('POST /:uid/suspend — 200', async () => {
      expect((await request(app).post('/api/v1/admin/administrators/target-1/suspend').send({})).status).toBe(200);
    });

    it('POST /:uid/reactivate — 200', async () => {
      expect((await request(app).post('/api/v1/admin/administrators/target-1/reactivate').send({})).status).toBe(200);
    });

    it('POST /:uid/revoke — 200', async () => {
      expect((await request(app).post('/api/v1/admin/administrators/target-1/revoke').send({})).status).toBe(200);
    });
  });
});
