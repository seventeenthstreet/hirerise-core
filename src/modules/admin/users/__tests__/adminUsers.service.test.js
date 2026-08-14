'use strict';

/**
 * adminUsers.service.test.js — WP-ADMIN-COMP-04
 *
 * Pure orchestration tests: the repository and audit logger are mocked, so
 * these assert that the service composes them correctly rather than
 * re-testing Supabase itself. Mirrors the mocking shape already used by
 * modules/admin/administrators/__tests__/administrators.service.test.js.
 */

jest.mock('../adminUsers.repository', () => ({
  findById: jest.fn(),
  updateRole: jest.fn(),
  updateProfile: jest.fn(),
  getAuthState: jest.fn(),
  setAccountStatus: jest.fn(),
  listAuditHistory: jest.fn(),
  ROLES: ['user', 'admin', 'super_admin', 'MASTER_ADMIN', 'contributor'],
}));

jest.mock('../../../../utils/adminAuditLogger', () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const usersRepo = require('../adminUsers.repository');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');
const service = require('../adminUsers.service');

function userRow(overrides = {}) {
  return {
    id: 'user-1',
    email: 'a@b.com',
    displayName: 'Ada',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    userType: 'professional',
    careerGoal: null,
    targetRole: null,
    experienceYears: null,
    industry: null,
    location: null,
    ...overrides,
  };
}

describe('adminUsers.service — WP-ADMIN-COMP-04', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getUser — Auth state merge', () => {
    it('merges accountStatus/authenticationProvider/lastLogin from getAuthState()', async () => {
      usersRepo.findById.mockResolvedValue(userRow());
      usersRepo.getAuthState.mockResolvedValue({
        accountStatus: 'active',
        authenticationProvider: 'email',
        lastLogin: '2026-02-01T00:00:00.000Z',
      });

      const result = await service.getUser('user-1');

      expect(result.accountStatus).toBe('active');
      expect(result.authenticationProvider).toBe('email');
      expect(result.lastLogin).toBe('2026-02-01T00:00:00.000Z');
      expect(result.mfaStatus).toBeNull();
    });

    it('falls back to null fields when Supabase Auth has no matching user', async () => {
      usersRepo.findById.mockResolvedValue(userRow());
      usersRepo.getAuthState.mockResolvedValue(null);

      const result = await service.getUser('user-1');

      expect(result.accountStatus).toBeNull();
      expect(result.authenticationProvider).toBeNull();
      expect(result.lastLogin).toBeNull();
    });

    it('does not fail the request when the Auth read throws', async () => {
      usersRepo.findById.mockResolvedValue(userRow());
      usersRepo.getAuthState.mockRejectedValue(new Error('Auth unreachable'));

      const result = await service.getUser('user-1');

      expect(result.accountStatus).toBeNull();
      expect(result.email).toBe('a@b.com');
    });

    it('throws 404 for a non-existent user', async () => {
      usersRepo.findById.mockResolvedValue(null);
      await expect(service.getUser('missing')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('updateUserProfile', () => {
    it('maps camelCase fields to snake_case columns and writes via the repository', async () => {
      usersRepo.updateProfile.mockResolvedValue(userRow({ careerGoal: 'PM', location: 'NYC' }));
      usersRepo.getAuthState.mockResolvedValue(null);

      await service.updateUserProfile('user-1', { careerGoal: 'PM', location: 'NYC' }, 'admin-1');

      expect(usersRepo.updateProfile).toHaveBeenCalledWith('user-1', {
        career_goal: 'PM',
        location: 'NYC',
      });
    });

    it('writes a USER_PROFILE_UPDATED audit entry naming only the changed fields', async () => {
      usersRepo.updateProfile.mockResolvedValue(userRow());
      usersRepo.getAuthState.mockResolvedValue(null);

      await service.updateUserProfile('user-1', { industry: 'Tech' }, 'admin-1');

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-1',
          action: 'USER_PROFILE_UPDATED',
          entityType: 'user',
          entityId: 'user-1',
          metadata: { fields: ['industry'] },
        })
      );
    });

    it('throws 404 when the user does not exist', async () => {
      usersRepo.updateProfile.mockResolvedValue(null);
      await expect(
        service.updateUserProfile('missing', { location: 'NYC' }, 'admin-1')
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('setUserAccountStatus', () => {
    it('disables the account and writes a USER_ACCOUNT_DISABLED audit entry', async () => {
      usersRepo.findById.mockResolvedValue(userRow());
      usersRepo.setAccountStatus.mockResolvedValue({
        accountStatus: 'disabled',
        authenticationProvider: 'email',
        lastLogin: null,
      });

      const result = await service.setUserAccountStatus('user-1', 'disable', 'admin-1');

      expect(usersRepo.setAccountStatus).toHaveBeenCalledWith('user-1', 'disable');
      expect(result.accountStatus).toBe('disabled');
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_ACCOUNT_DISABLED', entityType: 'user', entityId: 'user-1' })
      );
    });

    it('enables the account and writes a USER_ACCOUNT_ENABLED audit entry', async () => {
      usersRepo.findById.mockResolvedValue(userRow());
      usersRepo.setAccountStatus.mockResolvedValue({
        accountStatus: 'active',
        authenticationProvider: 'email',
        lastLogin: null,
      });

      await service.setUserAccountStatus('user-1', 'enable', 'admin-1');

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_ACCOUNT_ENABLED' })
      );
    });

    it('throws 404 when the public.users row does not exist', async () => {
      usersRepo.findById.mockResolvedValue(null);
      await expect(
        service.setUserAccountStatus('missing', 'disable', 'admin-1')
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 404 when there is no corresponding Supabase Auth user', async () => {
      usersRepo.findById.mockResolvedValue(userRow());
      usersRepo.setAccountStatus.mockResolvedValue(null);

      await expect(
        service.setUserAccountStatus('user-1', 'disable', 'admin-1')
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('getUserAuditHistory', () => {
    it('maps admin_logs rows to the API contract shape', async () => {
      usersRepo.findById.mockResolvedValue(userRow());
      usersRepo.listAuditHistory.mockResolvedValue([
        {
          id: 1,
          admin_id: 'admin-1',
          action: 'USER_ROLE_UPDATED',
          entity_type: 'user',
          entity_id: 'user-1',
          metadata: { toRole: 'admin' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ]);

      const events = await service.getUserAuditHistory('user-1');

      expect(events).toEqual([
        {
          id: 1,
          adminId: 'admin-1',
          action: 'USER_ROLE_UPDATED',
          entityType: 'user',
          entityId: 'user-1',
          metadata: { toRole: 'admin' },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });

    it('throws 404 when the user does not exist', async () => {
      usersRepo.findById.mockResolvedValue(null);
      await expect(service.getUserAuditHistory('missing')).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
