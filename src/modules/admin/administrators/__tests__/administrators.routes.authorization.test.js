'use strict';

/**
 * @file administrators.routes.authorization.test.js
 *
 * Master Admin > Admin Policy — Suspend/Reactivate Authorization Boundary.
 *
 * POLICY UPDATE (supersedes WP-ADMIN-05A-R1 for Suspend/Reactivate only):
 * ADMIN is delegated administrative authority and MUST NOT be able to
 * suspend or reactivate administrator principals. Only MASTER_ADMIN may.
 * This suite pins the resulting authorization matrix for every route on
 * this router — Grant/Revoke's existing MASTER_ADMIN-only placement is
 * unchanged and re-verified here rather than assumed.
 *
 * Route-level test: mounts the real router in a minimal Express app,
 * following the existing `permissionAdmin.routes.test.js` convention
 * (real router + real requireMasterAdmin middleware + a stub that injects
 * req.user, service layer mocked out). This test exists specifically to
 * pin the authorization placement this policy change affects — it does
 * not re-verify controller/service behaviour, which is already covered by
 * administrators.service.test.js.
 *
 * requireAdmin itself is NOT exercised here (it does its own DB
 * verification and has its own dedicated test suite,
 * requireAdmin.middleware.test.js) — this router is mounted directly, so
 * only requireMasterAdmin's route-level placement is under test. Contributor
 * / Editor / unauthenticated cases below are simulated the same way (via
 * req.user), consistent with that scoping — they exercise requireMasterAdmin's
 * own role/auth checks, not the full authenticate/requireAdmin mount chain.
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

const administratorsService = require('../administrators.service');
const administratorsRoutes = require('../administrators.routes');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  // Stands in for `authenticate` — the real requireMasterAdmin only reads
  // req.user, so this is sufficient to test its placement without pulling
  // in the real auth stack (out of scope for this policy change). Passing
  // `null` simulates an unauthenticated caller (no req.user set at all).
  app.use((req, res, next) => {
    if (user) req.user = user;
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
const CONTRIBUTOR_USER = { uid: 'contributor-1', id: 'contributor-1', role: 'contributor' };
const EDITOR_USER = { uid: 'editor-1', id: 'editor-1', role: 'editor' };
const ORDINARY_USER = { uid: 'user-1', id: 'user-1', role: 'user' };

describe('administrators.routes — Master Admin > Admin authorization placement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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
  });

  describe('ADMIN (non-MASTER_ADMIN) — forbidden', () => {
    const app = buildApp(ADMIN_USER);

    it('POST /:uid/suspend — 403 FORBIDDEN, service never called', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/suspend').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.suspendAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/reactivate — 403 FORBIDDEN, service never called', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/reactivate').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.reactivateAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/grant — 403 FORBIDDEN (unchanged regression)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/administrators/target-1/grant')
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.grantAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/revoke — 403 FORBIDDEN (unchanged regression)', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/revoke').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.revokeAdministrator).not.toHaveBeenCalled();
    });

    it('ADMIN cannot suspend a MASTER_ADMIN target either — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/master-1/suspend').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.suspendAdministrator).not.toHaveBeenCalled();
    });

    it('ADMIN cannot reactivate a MASTER_ADMIN target either — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/master-1/reactivate').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.reactivateAdministrator).not.toHaveBeenCalled();
    });

    it('ADMIN cannot bypass the suspend restriction via the grant route', async () => {
      // Grant was already MASTER_ADMIN-only before this policy change; this
      // confirms an ADMIN cannot achieve a suspend-equivalent effect (or any
      // other restricted mutation) by calling a different route on this router.
      const res = await request(app)
        .post('/api/v1/admin/administrators/target-1/grant')
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
      expect(administratorsService.grantAdministrator).not.toHaveBeenCalled();
      expect(administratorsService.suspendAdministrator).not.toHaveBeenCalled();
    });
  });

  describe('Contributor — forbidden', () => {
    const app = buildApp(CONTRIBUTOR_USER);

    it('POST /:uid/suspend — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/suspend').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.suspendAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/reactivate — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/reactivate').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.reactivateAdministrator).not.toHaveBeenCalled();
    });
  });

  describe('Editor — forbidden', () => {
    const app = buildApp(EDITOR_USER);

    it('POST /:uid/suspend — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/suspend').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.suspendAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/reactivate — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/reactivate').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.reactivateAdministrator).not.toHaveBeenCalled();
    });
  });

  describe('USER (ordinary application user) — forbidden', () => {
    const app = buildApp(ORDINARY_USER);

    it('POST /:uid/suspend — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/suspend').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.suspendAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/reactivate — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/reactivate').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.reactivateAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/revoke — 403 FORBIDDEN', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/revoke').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.revokeAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/grant — 403 FORBIDDEN', async () => {
      const res = await request(app)
        .post('/api/v1/admin/administrators/target-1/grant')
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(administratorsService.grantAdministrator).not.toHaveBeenCalled();
    });
  });

  describe('Unauthenticated — 401', () => {
    const app = buildApp(null);

    it('POST /:uid/suspend — 401 UNAUTHORIZED', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/suspend').send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(administratorsService.suspendAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/reactivate — 401 UNAUTHORIZED', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/reactivate').send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(administratorsService.reactivateAdministrator).not.toHaveBeenCalled();
    });

    it('POST /:uid/revoke — 401 UNAUTHORIZED', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/revoke').send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(administratorsService.revokeAdministrator).not.toHaveBeenCalled();
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
      const res = await request(app).post('/api/v1/admin/administrators/target-1/suspend').send({});
      expect(res.status).toBe(200);
      expect(administratorsService.suspendAdministrator).toHaveBeenCalledWith('target-1', 'master-1', null);
    });

    it('POST /:uid/reactivate — 200', async () => {
      const res = await request(app).post('/api/v1/admin/administrators/target-1/reactivate').send({});
      expect(res.status).toBe(200);
      expect(administratorsService.reactivateAdministrator).toHaveBeenCalledWith('target-1', 'master-1');
    });

    it('POST /:uid/revoke — 200', async () => {
      expect((await request(app).post('/api/v1/admin/administrators/target-1/revoke').send({})).status).toBe(200);
    });
  });
});
