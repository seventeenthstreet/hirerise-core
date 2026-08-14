'use strict';

/**
 * @file supabaseClientAccess.test.js
 * @description
 * WP-ADMIN-COMP-02 — adminCmsRoles.repository.js previously did
 * `const supabase = require('.../config/supabase');` (the whole config
 * module, missing `.supabase`), then called `supabase.from('cms_roles')`
 * directly at every call site -- throwing `TypeError: supabase.from is
 * not a function` on every CMS Roles request.
 */

function mockSupabaseModule() {
  const builder = {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
  };
  const from = jest.fn(() => builder);
  const client = { from };

  return {
    supabase: client,
    getClient: jest.fn(() => client),
    withRetry: jest.fn((fn) => fn()),
    verifyConnection: jest.fn(),
    __client: client,
  };
}

describe('adminCmsRoles.repository.js — Supabase client access (WP-ADMIN-COMP-02)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('findByCompositeKey resolves the real client (not the config module)', async () => {
    const mocked = mockSupabaseModule();
    jest.doMock('../../../../../config/supabase', () => mocked);

    const rolesRepo = require('../adminCmsRoles.repository');

    await expect(
      rolesRepo.findByCompositeKey('engineering::software-engineer')
    ).resolves.toBeNull();

    expect(mocked.__client.from).toHaveBeenCalledWith('cms_roles');
  });
});
