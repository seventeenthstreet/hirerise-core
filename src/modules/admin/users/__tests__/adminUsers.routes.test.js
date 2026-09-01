'use strict';

/**
 * adminUsers.routes.test.js — Admin Authorization Role Reconciliation
 *
 * Route-level test: mounts the real router in a minimal Express app
 * (service layer mocked out), following the existing
 * adminWeights.routes.test.js / administrators.routes.authorization.test.js
 * convention of testing the real router + real express-validator chain
 * with a stubbed req.user.
 *
 * This suite does not re-test authenticate/requireAdmin/requireElevatedSession
 * themselves (see adminUsers.routes.js's module doc comment — that chain is
 * applied once at the server.js mount point, unchanged by this work). What
 * IS covered here is the actual defect this reconciliation fixes: that
 * PATCH /admin/users/:userId/role now rejects admin / super_admin /
 * MASTER_ADMIN at the validation layer (before the controller/service ever
 * runs), while 'user', 'contributor', and (WP-ADMIN-04G) 'editor' remain
 * allowed — proving Administrator authority can no longer be minted through
 * this endpoint.
 *
 * WP-ADMIN-04G: the allowed-values list below is read from
 * usersRepo.ASSIGNABLE_ROLES (the same single source of truth
 * adminUsers.routes.js's validator itself uses) rather than hard-coded, so
 * this suite can't silently drift out of sync with that constant again.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../adminUsers.service', () => ({
  listUsers: jest.fn(),
  getUser: jest.fn(),
  updateUserRole: jest.fn(),
  updateUserProfile: jest.fn(),
  setUserAccountStatus: jest.fn(),
  getUserAuditHistory: jest.fn(),
}));

const usersService = require('../adminUsers.service');
const usersRoutes = require('../adminUsers.routes');
const usersRepo = require('../adminUsers.repository');
const { errorHandler } = require('../../../../middleware/errorHandler');

function buildApp(user = { id: 'admin-1', uid: 'admin-1', role: 'admin' }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/v1/admin/users', usersRoutes);
  app.use(errorHandler);
  return app;
}

describe('adminUsers.routes — PATCH /:userId/role (Admin Authorization Role Reconciliation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('allowed values — application-level roles only', () => {
    it.each(usersRepo.ASSIGNABLE_ROLES)('accepts role=%s and calls the service', async (role) => {
      usersService.updateUserRole.mockResolvedValue({ id: 'target-1', role });
      const app = buildApp();

      const res = await request(app)
        .patch('/api/v1/admin/users/target-1/role')
        .send({ role });

      expect(res.status).toBe(200);
      expect(usersService.updateUserRole).toHaveBeenCalledWith('target-1', role, 'admin-1');
    });
  });

  describe('rejected values — Administrator authority cannot be granted here', () => {
    it.each(['admin', 'super_admin', 'MASTER_ADMIN'])(
      'rejects role=%s with 400 before the service is ever called',
      async (role) => {
        const app = buildApp();

        const res = await request(app)
          .patch('/api/v1/admin/users/target-1/role')
          .send({ role });

        expect(res.status).toBe(400);
        expect(usersService.updateUserRole).not.toHaveBeenCalled();
      }
    );
  });

  it('rejects an unrecognized role value the same way', async () => {
    const app = buildApp();

    const res = await request(app)
      .patch('/api/v1/admin/users/target-1/role')
      .send({ role: 'not-a-real-role' });

    expect(res.status).toBe(400);
    expect(usersService.updateUserRole).not.toHaveBeenCalled();
  });

  describe('self-role-change protection (unchanged by this reconciliation)', () => {
    it('forbids an admin from changing their own role, even to an allowed value', async () => {
      const app = buildApp({ id: 'admin-1', uid: 'admin-1', role: 'admin' });

      const res = await request(app)
        .patch('/api/v1/admin/users/admin-1/role')
        .send({ role: 'contributor' });

      expect(res.status).toBe(403);
      expect(usersService.updateUserRole).not.toHaveBeenCalled();
    });
  });
});
