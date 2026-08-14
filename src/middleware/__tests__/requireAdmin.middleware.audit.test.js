'use strict';

const { createAdminPrincipalsSupabaseMock } = require(
  '../../modules/admin/repository/testHelpers/adminPrincipalsSupabaseMock'
);

let mock;

jest.mock('../../config/supabase', () => ({
  get supabase() {
    return mock;
  },
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockLogAdminAction = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/adminAuditLogger', () => ({
  logAdminAction: (...args) => mockLogAdminAction(...args),
}));

function makeReq(user) {
  return { user, headers: {}, originalUrl: '/admin/anything', ip: '127.0.0.1' };
}

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function baseRow(overrides = {}) {
  return {
    uid: 'admin-1',
    role: 'admin',
    status: 'active',
    verified_at: new Date().toISOString(),
    last_action_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('requireAdmin middleware — audit generation (WP-ADMIN-04F-18C)', () => {
  let requireAdmin;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    mock = createAdminPrincipalsSupabaseMock([baseRow()]);
    mockLogAdminAction.mockClear();
    ({ requireAdmin } = require('../requireAdmin.middleware'));
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it('emits ADMIN_VERIFICATION_FAILED for a suspended admin, and still returns 403', async () => {
    mock.__setRows([baseRow({ status: 'suspended' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        action: 'ADMIN_VERIFICATION_FAILED',
        entityType: 'admin_principal',
        entityId: 'admin-1',
        metadata: expect.objectContaining({ status: 'suspended' }),
      })
    );
  });

  it('does not emit a verification-failure audit event for a valid active admin', async () => {
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('does not emit an audit event for the pre-DB 403 (no admin claim) — no principal to attribute it to', async () => {
    const req = makeReq({ uid: 'user-1', role: 'jobseeker' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('a logAdminAction failure does not change the 403 outcome (fail-open-on-audit)', async () => {
    mockLogAdminAction.mockRejectedValueOnce(new Error('audit store unavailable'));
    mock.__setRows([baseRow({ status: 'revoked' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
