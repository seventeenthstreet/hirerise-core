'use strict';

/**
 * ordinaryRoleSync.test.js — WP-ADMIN-04G
 *
 * The projection logic itself (read-modify-write against Supabase Auth) is
 * already covered by shared/auth/__tests__/roleAuthProjection.test.js —
 * this suite only verifies that syncOrdinaryRoleToAuth() delegates
 * correctly and logs its own ([OrdinaryRoleSync]-prefixed) context on
 * failure, never on success.
 */

const mockProjectRoleToAuthMetadata = jest.fn();

jest.mock('../../../../shared/auth/roleAuthProjection', () => ({
  projectRoleToAuthMetadata: (...args) => mockProjectRoleToAuthMetadata(...args),
}));

jest.mock('../../../../utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../../../utils/logger');
const { syncOrdinaryRoleToAuth } = require('../ordinaryRoleSync');

describe('ordinaryRoleSync#syncOrdinaryRoleToAuth (WP-ADMIN-04G)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates uid/role to the shared projection helper and returns its result', async () => {
    mockProjectRoleToAuthMetadata.mockResolvedValue({ synchronized: true, error: null });

    const result = await syncOrdinaryRoleToAuth('uid-1', 'editor');

    expect(mockProjectRoleToAuthMetadata).toHaveBeenCalledWith('uid-1', 'editor');
    expect(result).toEqual({ synchronized: true, error: null });
  });

  it('does not log on a successful sync', async () => {
    mockProjectRoleToAuthMetadata.mockResolvedValue({ synchronized: true, error: null });

    await syncOrdinaryRoleToAuth('uid-1', 'contributor');

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs [OrdinaryRoleSync]-prefixed context on failure, without throwing', async () => {
    mockProjectRoleToAuthMetadata.mockResolvedValue({ synchronized: false, error: 'Auth unreachable' });

    const result = await syncOrdinaryRoleToAuth('uid-1', 'user');

    expect(result).toEqual({ synchronized: false, error: 'Auth unreachable' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[OrdinaryRoleSync]'),
      expect.objectContaining({ uid: 'uid-1', role: 'user', error: 'Auth unreachable' })
    );
  });
});
