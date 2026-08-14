'use strict';

/**
 * adminAuth.routes.lifecycle.test.js — WP-ADMIN-04F-18B
 *
 * Route-level test: mounts the real router in a minimal Express app.
 * requireAdmin is mocked to a pass-through (its own lifecycle-enforcement
 * behavior has dedicated coverage in
 * src/middleware/__tests__/requireAdmin.middleware.test.js); this file
 * only verifies the new /suspend and /reactivate routes are wired
 * correctly, MASTER_ADMIN-gated, self-protected, and translate
 * InvalidLifecycleTransitionError into 409s — plus a regression check
 * that /grant and /revoke still behave as before.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth.middleware', () => ({
  requireAdmin: (req, res, next) => next(),
}));

const mockRepo = {
  grant: jest.fn(),
  suspend: jest.fn(),
  reactivate: jest.fn(),
  revoke: jest.fn(),
  verify: jest.fn(),
  refreshSession: jest.fn(),
  listActive: jest.fn(async () => []),
};

jest.mock('../../../modules/admin/repository/adminPrincipal.repository', () => mockRepo);

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { InvalidLifecycleTransitionError } = require('../../../domain/admin/lifecycle/adminLifecycle.states');
const adminAuthRoutes = require('../adminAuth.routes');

function makeApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/admin/auth', adminAuthRoutes);
  return app;
}

const MASTER = { uid: 'master-1', role: 'MASTER_ADMIN' };
const NON_MASTER_ADMIN = { uid: 'admin-2', role: 'admin' };

describe('adminAuth.routes — lifecycle endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /suspend', () => {
    it('403s for a non-MASTER_ADMIN caller', async () => {
      const app = makeApp(NON_MASTER_ADMIN);
      const res = await request(app).post('/admin/auth/suspend').send({ uid: 'target-1' });

      expect(res.status).toBe(403);
      expect(mockRepo.suspend).not.toHaveBeenCalled();
    });

    it('400s when suspending self', async () => {
      const app = makeApp(MASTER);
      const res = await request(app).post('/admin/auth/suspend').send({ uid: MASTER.uid });

      expect(res.status).toBe(400);
      expect(mockRepo.suspend).not.toHaveBeenCalled();
    });

    it('suspends the target and returns 200', async () => {
      mockRepo.suspend.mockResolvedValue(undefined);
      const app = makeApp(MASTER);

      const res = await request(app)
        .post('/admin/auth/suspend')
        .send({ uid: 'target-1', reason: 'policy violation' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRepo.suspend).toHaveBeenCalledWith('target-1', MASTER.uid, 'policy violation');
    });

    it('translates an invalid transition into 409', async () => {
      mockRepo.suspend.mockRejectedValue(
        new InvalidLifecycleTransitionError('suspend', 'revoked')
      );
      const app = makeApp(MASTER);

      const res = await request(app).post('/admin/auth/suspend').send({ uid: 'target-1' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('400s when uid is missing (validation, regression pattern)', async () => {
      const app = makeApp(MASTER);
      const res = await request(app).post('/admin/auth/suspend').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /reactivate', () => {
    it('403s for a non-MASTER_ADMIN caller', async () => {
      const app = makeApp(NON_MASTER_ADMIN);
      const res = await request(app).post('/admin/auth/reactivate').send({ uid: 'target-1' });

      expect(res.status).toBe(403);
      expect(mockRepo.reactivate).not.toHaveBeenCalled();
    });

    it('reactivates the target and returns 200', async () => {
      mockRepo.reactivate.mockResolvedValue(undefined);
      const app = makeApp(MASTER);

      const res = await request(app).post('/admin/auth/reactivate').send({ uid: 'target-1' });

      expect(res.status).toBe(200);
      expect(mockRepo.reactivate).toHaveBeenCalledWith('target-1', MASTER.uid);
    });

    it('translates an invalid transition into 409', async () => {
      mockRepo.reactivate.mockRejectedValue(
        new InvalidLifecycleTransitionError('reactivate', 'active')
      );
      const app = makeApp(MASTER);

      const res = await request(app).post('/admin/auth/reactivate').send({ uid: 'target-1' });

      expect(res.status).toBe(409);
    });
  });

  // ── Regression: existing /grant and /revoke behavior unchanged ─────────

  describe('POST /grant (regression)', () => {
    it('grants for a MASTER_ADMIN caller', async () => {
      mockRepo.grant.mockResolvedValue(undefined);
      const app = makeApp(MASTER);

      const res = await request(app)
        .post('/admin/auth/grant')
        .send({ uid: 'target-1', role: 'admin' });

      expect(res.status).toBe(200);
      expect(mockRepo.grant).toHaveBeenCalledWith('target-1', 'admin', MASTER.uid);
    });

    it('403s for a non-MASTER_ADMIN caller', async () => {
      const app = makeApp(NON_MASTER_ADMIN);
      const res = await request(app)
        .post('/admin/auth/grant')
        .send({ uid: 'target-1', role: 'admin' });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /revoke (regression)', () => {
    it('400s when revoking self (unchanged)', async () => {
      const app = makeApp(MASTER);
      const res = await request(app).post('/admin/auth/revoke').send({ uid: MASTER.uid });

      expect(res.status).toBe(400);
      expect(mockRepo.revoke).not.toHaveBeenCalled();
    });

    it('revokes the target and returns 200', async () => {
      mockRepo.revoke.mockResolvedValue(undefined);
      const app = makeApp(MASTER);

      const res = await request(app).post('/admin/auth/revoke').send({ uid: 'target-1' });

      expect(res.status).toBe(200);
      expect(mockRepo.revoke).toHaveBeenCalledWith('target-1', MASTER.uid);
    });

    it('translates an invalid transition into 409 (new: previously would 500)', async () => {
      mockRepo.revoke.mockRejectedValue(
        new InvalidLifecycleTransitionError('revoke', 'revoked')
      );
      const app = makeApp(MASTER);

      const res = await request(app).post('/admin/auth/revoke').send({ uid: 'target-1' });

      expect(res.status).toBe(409);
    });
  });
});
