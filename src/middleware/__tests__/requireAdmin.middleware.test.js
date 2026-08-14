'use strict';

/**
 * requireAdmin.middleware.test.js — WP-ADMIN-04F-18B
 *
 * Covers:
 *  - Lifecycle enforcement (Phase 6): suspended/revoked/expired admins are
 *    rejected with distinct error codes; active admins pass unchanged.
 *  - Regression: authentication (401), authorization/admin-claim checks
 *    (403 FORBIDDEN), MASTER_ADMIN TTL bypass, and the 24h session TTL
 *    for non-MASTER_ADMIN principals are all unchanged by this work
 *    package.
 *  - Bugfix coverage: verification now actually reaches a row keyed by
 *    `uid` (previously queried the nonexistent `user_id` column).
 */

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

describe('requireAdmin middleware', () => {
  let requireAdmin;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production'; // SHOULD_VERIFY_DB = true
    mock = createAdminPrincipalsSupabaseMock([baseRow()]);
    ({ requireAdmin } = require('../requireAdmin.middleware'));
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.ADMIN_HARDENING_ENABLED;
  });

  // ── Regression: auth / claim checks unchanged ──────────────────────────

  it('401s with no user (regression)', async () => {
    const req = makeReq(null);
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403 FORBIDDEN with no admin claim, before any DB check (regression)', async () => {
    const req = makeReq({ uid: 'user-1', role: 'jobseeker' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  // ── Bugfix: verification actually reaches the row ──────────────────────

  it('finds the principal by uid (bugfix) and calls next() for an active admin', async () => {
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.adminPrincipal).toMatchObject({ uid: 'admin-1', status: 'active' });
  });

  // ── Lifecycle enforcement (Phase 6) ─────────────────────────────────────

  it('rejects a suspended admin with ADMIN_SUSPENDED', async () => {
    mock.__setRows([baseRow({ status: 'suspended' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_SUSPENDED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a revoked admin with ADMIN_REVOKED', async () => {
    mock.__setRows([baseRow({ status: 'revoked' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_REVOKED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an expired admin with ADMIN_EXPIRED', async () => {
    mock.__setRows([baseRow({ status: 'expired' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_EXPIRED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unknown principal with ADMIN_SESSION_EXPIRED (regression: no row -> generic code)', async () => {
    mock.__setRows([]);
    const req = makeReq({ uid: 'ghost', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_SESSION_EXPIRED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  // ── Regression: session TTL + MASTER_ADMIN bypass unchanged ────────────

  it('rejects an active admin whose session is older than 24h (regression)', async () => {
    mock.__setRows([
      baseRow({ verified_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }),
    ]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_SESSION_EXPIRED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('MASTER_ADMIN bypasses the 24h TTL but still needs status=active (regression + lifecycle)', async () => {
    mock.__setRows([
      baseRow({
        role: 'MASTER_ADMIN',
        verified_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const req = makeReq({ uid: 'admin-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();

    // Now suspend the same MASTER_ADMIN row — TTL bypass must not also
    // bypass lifecycle status.
    mock.__setRows([baseRow({ role: 'MASTER_ADMIN', status: 'suspended' })]);
    const req2 = makeReq({ uid: 'admin-1', role: 'MASTER_ADMIN' });
    const res2 = makeRes();
    const next2 = jest.fn();

    await requireAdmin(req2, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).toHaveBeenCalledWith(403);
  });

  // ── Non-hardened environments unaffected (regression) ───────────────────

  it('skips DB verification entirely outside production without hardening flag (regression)', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.ADMIN_HARDENING_ENABLED;
    mock = createAdminPrincipalsSupabaseMock([]); // no row at all — would fail if DB-checked

    ({ requireAdmin } = require('../requireAdmin.middleware'));

    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
