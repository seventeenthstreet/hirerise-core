'use strict';

let mockAuthAdmin;

jest.mock('../../../../config/supabase', () => ({
  get supabase() {
    return { auth: { admin: mockAuthAdmin } };
  },
}));

jest.mock('../../../../utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const { syncAdminRoleToAuth } = require('../adminAuthSync');

describe('adminAuthSync#syncAdminRoleToAuth (WP-ADMIN-IMP-07)', () => {
  beforeEach(() => {
    mockAuthAdmin = {
      getUserById: jest.fn(),
      updateUserById: jest.fn(),
    };
  });

  it('rejects missing uid/role without touching Supabase', async () => {
    await expect(syncAdminRoleToAuth(null, 'MASTER_ADMIN')).resolves.toEqual({
      synchronized: false,
      error: 'uid and role are required',
    });
    expect(mockAuthAdmin.getUserById).not.toHaveBeenCalled();
  });

  it('merges role/roles into existing app_metadata rather than overwriting it', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({
      data: { user: { id: 'uid-1', app_metadata: { provider: 'email', plan: 'pro' } } },
      error: null,
    });
    mockAuthAdmin.updateUserById.mockResolvedValue({ data: { user: {} }, error: null });

    const result = await syncAdminRoleToAuth('uid-1', 'MASTER_ADMIN');

    expect(result).toEqual({ synchronized: true, error: null });
    expect(mockAuthAdmin.updateUserById).toHaveBeenCalledWith('uid-1', {
      app_metadata: {
        provider: 'email',
        plan: 'pro',
        role: 'MASTER_ADMIN',
        roles: ['MASTER_ADMIN'],
      },
    });
  });

  it('reports failure explicitly (never throws) when the Auth user does not exist', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({ data: { user: null }, error: null });

    const result = await syncAdminRoleToAuth('missing-uid', 'MASTER_ADMIN');

    expect(result.synchronized).toBe(false);
    expect(result.error).toMatch(/No Supabase Auth user found/);
    expect(mockAuthAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('reports failure explicitly when the read call errors', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({ data: null, error: new Error('network error') });

    const result = await syncAdminRoleToAuth('uid-1', 'MASTER_ADMIN');

    expect(result).toEqual({ synchronized: false, error: 'network error' });
    expect(mockAuthAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('reports failure explicitly when the write call errors', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({
      data: { user: { id: 'uid-1', app_metadata: {} } },
      error: null,
    });
    mockAuthAdmin.updateUserById.mockResolvedValue({ data: null, error: new Error('write failed') });

    const result = await syncAdminRoleToAuth('uid-1', 'MASTER_ADMIN');

    expect(result).toEqual({ synchronized: false, error: 'write failed' });
  });

  it('never throws, even on an unexpected exception', async () => {
    mockAuthAdmin.getUserById.mockRejectedValue(new Error('boom'));

    await expect(syncAdminRoleToAuth('uid-1', 'MASTER_ADMIN')).resolves.toEqual({
      synchronized: false,
      error: 'boom',
    });
  });
});
