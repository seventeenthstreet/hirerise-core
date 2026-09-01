'use strict';

/**
 * @file adminCredits.routes.authorization.test.js
 *
 * Phase 4 Usage/Credits Contract Lock — Phase 3 Contract §19/§31 security
 * matrix: reads are ADMIN + MASTER_ADMIN; Grant/Adjust are MASTER_ADMIN
 * only. Lower roles and unauthenticated callers are denied everywhere.
 *
 * Route-level test, following administrators.routes.authorization.test.js's
 * established convention: mounts the real router with the real
 * requireMasterAdmin middleware, service layer mocked out, req.user
 * injected directly (requireAdmin/requireElevatedSession are exercised by
 * their own dedicated suites and by the mount-point wiring in server.js,
 * not re-tested here).
 */

const express = require('express');
const request = require('supertest');

jest.mock('../adminCredits.service', () => ({
  getUserCreditSummary: jest.fn(() => Promise.resolve({
    user: { id: 'target-1', email: 'target@example.com', displayName: null, role: 'user' },
    creditBalance: 10,
    quota: { usageCounter: { monthlyAiUsageCount: 0, aiUsageResetDate: null }, featureQuota: { monthKey: '2026-08', features: [] } },
    ledger: { items: [], total: 0, limit: 25, offset: 0 },
  })),
  listLedger: jest.fn(() => Promise.resolve({ items: [], total: 0, limit: 25, offset: 0 })),
  grantCredits: jest.fn(() => Promise.resolve({ balanceAfter: 15, ledgerId: 'ledger-1' })),
  adjustCredits: jest.fn(() => Promise.resolve({ balanceAfter: 8, ledgerId: 'ledger-2' })),
}));

const creditsService = require('../adminCredits.service');
const creditsRoutes = require('../adminCredits.routes');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/v1/admin/credits', creditsRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

const MASTER_ADMIN_USER = { uid: 'master-1', id: 'master-1', role: 'MASTER_ADMIN' };
const ADMIN_USER = { uid: 'admin-1', id: 'admin-1', role: 'admin' };
const EDITOR_USER = { uid: 'editor-1', id: 'editor-1', role: 'editor' };
const CONTRIBUTOR_USER = { uid: 'contributor-1', id: 'contributor-1', role: 'contributor' };
const ORDINARY_USER = { uid: 'user-1', id: 'user-1', role: 'user' };

const VALID_GRANT_BODY = { userId: 'target-1', amount: 5, reason: 'goodwill credit', referenceId: 'ref-grant-1' };
const VALID_ADJUST_BODY = { userId: 'target-1', adjustment: -2, reason: 'correction', referenceId: 'ref-adjust-1' };

describe('adminCredits.routes — security matrix (Phase 3 Contract §31)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('View credits / ledger — ADMIN and MASTER_ADMIN allowed', () => {
    it.each([
      ['ADMIN', ADMIN_USER],
      ['MASTER_ADMIN', MASTER_ADMIN_USER],
    ])('%s can GET /user/:idOrEmail', async (_label, user) => {
      const app = buildApp(user);
      const res = await request(app).get('/api/v1/admin/credits/user/target-1');
      expect(res.status).toBe(200);
    });

    it.each([
      ['ADMIN', ADMIN_USER],
      ['MASTER_ADMIN', MASTER_ADMIN_USER],
    ])('%s can GET /user/:userId/ledger', async (_label, user) => {
      const app = buildApp(user);
      const res = await request(app).get('/api/v1/admin/credits/user/target-1/ledger');
      expect(res.status).toBe(200);
    });
  });

  describe('View credits / ledger — mount-point authorization', () => {
    // This router itself has no route-level role check on GET — reads are
    // gated by `requireAdmin` at the server.js mount point, identical to
    // /admin/users and /admin/weights (see adminWeights.routes.js's own
    // module doc comment: "All routes inherit authenticate + requireAdmin
    // + requireElevatedSession from the mount point"). That mount-point
    // wiring is pinned by adminCredits.mount.test.js rather than
    // re-implemented here with a stub requireAdmin, so this suite is not
    // testing a false sense of security around GET.
  });

  describe('Grant — MASTER_ADMIN only', () => {
    it('MASTER_ADMIN succeeds', async () => {
      const app = buildApp(MASTER_ADMIN_USER);
      const res = await request(app).post('/api/v1/admin/credits/grant').send(VALID_GRANT_BODY);
      expect(res.status).toBe(200);
      expect(creditsService.grantCredits).toHaveBeenCalledWith(
        expect.objectContaining({ targetUserId: 'target-1', amount: 5, actorAdminId: 'master-1' })
      );
    });

    it.each([
      ['ADMIN', ADMIN_USER, 403],
      ['EDITOR', EDITOR_USER, 403],
      ['CONTRIBUTOR', CONTRIBUTOR_USER, 403],
      ['USER', ORDINARY_USER, 403],
    ])('%s is denied (%i)', async (_label, user, expectedStatus) => {
      const app = buildApp(user);
      const res = await request(app).post('/api/v1/admin/credits/grant').send(VALID_GRANT_BODY);
      expect(res.status).toBe(expectedStatus);
      expect(creditsService.grantCredits).not.toHaveBeenCalled();
    });

    it('unauthenticated is denied (401)', async () => {
      const app = buildApp(null);
      const res = await request(app).post('/api/v1/admin/credits/grant').send(VALID_GRANT_BODY);
      expect(res.status).toBe(401);
      expect(creditsService.grantCredits).not.toHaveBeenCalled();
    });
  });

  describe('Adjust — MASTER_ADMIN only', () => {
    it('MASTER_ADMIN succeeds', async () => {
      const app = buildApp(MASTER_ADMIN_USER);
      const res = await request(app).post('/api/v1/admin/credits/adjust').send(VALID_ADJUST_BODY);
      expect(res.status).toBe(200);
      expect(creditsService.adjustCredits).toHaveBeenCalledWith(
        expect.objectContaining({ targetUserId: 'target-1', adjustment: -2, actorAdminId: 'master-1' })
      );
    });

    it.each([
      ['ADMIN', ADMIN_USER, 403],
      ['EDITOR', EDITOR_USER, 403],
      ['CONTRIBUTOR', CONTRIBUTOR_USER, 403],
      ['USER', ORDINARY_USER, 403],
    ])('%s is denied (%i)', async (_label, user, expectedStatus) => {
      const app = buildApp(user);
      const res = await request(app).post('/api/v1/admin/credits/adjust').send(VALID_ADJUST_BODY);
      expect(res.status).toBe(expectedStatus);
      expect(creditsService.adjustCredits).not.toHaveBeenCalled();
    });

    it('unauthenticated is denied (401)', async () => {
      const app = buildApp(null);
      const res = await request(app).post('/api/v1/admin/credits/adjust').send(VALID_ADJUST_BODY);
      expect(res.status).toBe(401);
      expect(creditsService.adjustCredits).not.toHaveBeenCalled();
    });
  });

  describe('Grant validation', () => {
    it('rejects missing reason', async () => {
      const app = buildApp(MASTER_ADMIN_USER);
      const res = await request(app)
        .post('/api/v1/admin/credits/grant')
        .send({ userId: 'target-1', amount: 5, referenceId: 'ref-1' });
      expect(res.status).toBe(400);
    });

    it('rejects missing referenceId', async () => {
      const app = buildApp(MASTER_ADMIN_USER);
      const res = await request(app)
        .post('/api/v1/admin/credits/grant')
        .send({ userId: 'target-1', amount: 5, reason: 'reason' });
      expect(res.status).toBe(400);
    });

    it('rejects non-positive amount', async () => {
      const app = buildApp(MASTER_ADMIN_USER);
      const res = await request(app)
        .post('/api/v1/admin/credits/grant')
        .send({ userId: 'target-1', amount: 0, reason: 'reason', referenceId: 'ref-1' });
      expect(res.status).toBe(400);
    });
  });

  describe('Adjust validation', () => {
    it('rejects zero adjustment', async () => {
      const app = buildApp(MASTER_ADMIN_USER);
      const res = await request(app)
        .post('/api/v1/admin/credits/adjust')
        .send({ userId: 'target-1', adjustment: 0, reason: 'reason', referenceId: 'ref-1' });
      expect(res.status).toBe(400);
    });

    it('accepts negative adjustment', async () => {
      const app = buildApp(MASTER_ADMIN_USER);
      const res = await request(app)
        .post('/api/v1/admin/credits/adjust')
        .send({ userId: 'target-1', adjustment: -3, reason: 'reason', referenceId: 'ref-1' });
      expect(res.status).toBe(200);
    });
  });
});
