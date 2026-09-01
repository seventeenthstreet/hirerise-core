'use strict';

/**
 * roleAuthProjection.test.js — WP-ADMIN-04G
 *
 * Mirrors adminAuthSync.test.js's mocking shape and coverage exactly,
 * since this module is the extracted implementation that test file's
 * subject now delegates to. Kept as its own suite so the low-level
 * primitive is verified independently of either caller (adminAuthSync.js /
 * ordinaryRoleSync.js).
 */

let mockAuthAdmin;

jest.mock('../../../config/supabase', () => ({
  get supabase() {
    return { auth: { admin: mockAuthAdmin } };
  },
}));

const { projectRoleToAuthMetadata } = require('../roleAuthProjection');

describe('roleAuthProjection#projectRoleToAuthMetadata (WP-ADMIN-04G)', () => {
  beforeEach(() => {
    mockAuthAdmin = {
      getUserById: jest.fn(),
      updateUserById: jest.fn(),
    };
  });

  it('rejects missing uid/role without touching Supabase', async () => {
    await expect(projectRoleToAuthMetadata(null, 'editor')).resolves.toEqual({
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

    const result = await projectRoleToAuthMetadata('uid-1', 'editor');

    expect(result).toEqual({ synchronized: true, error: null });
    expect(mockAuthAdmin.updateUserById).toHaveBeenCalledWith('uid-1', {
      app_metadata: {
        provider: 'email',
        plan: 'pro',
        role: 'editor',
        roles: ['editor'],
      },
    });
  });

  it('reports failure explicitly (never throws) when the Auth user does not exist', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({ data: { user: null }, error: null });

    const result = await projectRoleToAuthMetadata('missing-uid', 'contributor');

    expect(result.synchronized).toBe(false);
    expect(result.error).toMatch(/No Supabase Auth user found/);
    expect(mockAuthAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('reports failure explicitly when the read call errors', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({ data: null, error: new Error('network error') });

    const result = await projectRoleToAuthMetadata('uid-1', 'contributor');

    expect(result).toEqual({ synchronized: false, error: 'network error' });
    expect(mockAuthAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('reports failure explicitly when the write call errors', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({
      data: { user: { id: 'uid-1', app_metadata: {} } },
      error: null,
    });
    mockAuthAdmin.updateUserById.mockResolvedValue({ data: null, error: new Error('write failed') });

    const result = await projectRoleToAuthMetadata('uid-1', 'contributor');

    expect(result).toEqual({ synchronized: false, error: 'write failed' });
  });

  it('never throws, even on an unexpected exception', async () => {
    mockAuthAdmin.getUserById.mockRejectedValue(new Error('boom'));

    await expect(projectRoleToAuthMetadata('uid-1', 'user')).resolves.toEqual({
      synchronized: false,
      error: 'boom',
    });
  });
});
