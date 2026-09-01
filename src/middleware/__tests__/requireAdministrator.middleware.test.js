'use strict';

/**
 * requireAdministrator.middleware.test.js — Blocker 1
 *
 * Covers:
 *  - Regression: unauthenticated (401) and no-claim (403 FORBIDDEN) checks
 *    match verifyAdmin.middleware.js's historical behaviour and still
 *    short-circuit before any DB call.
 *  - New lifecycle enforcement: an admin/super_admin JWT claim is no
 *    longer sufficient on its own — the backing admin_principals row
 *    must also be status='active' (and within TTL). Suspended / revoked /
 *    expired / missing principals are rejected with the same error codes
 *    requireAdmin.middleware.js and requireMasterAdmin.middleware.js
 *    already use for the equivalent states.
 *  - Role-boundary preservation: MASTER_ADMIN must remain DENIED, exactly
 *    as verifyAdmin.middleware.js's old hasAdminAccess() denied it. This
 *    is the specific "no accidental broadening" case Blocker 1 exists to
 *    guard against — proven both via JWT claim (should never reach the
 *    DB check) and via an active DB principal whose role is MASTER_ADMIN
 *    (should be denied post-lifecycle-check, not silently admitted).
 *  - super_admin is allowed (regression parity with old verifyAdmin).
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
  return { user, headers: {}, originalUrl: '/api/v1/onboarding/analytics/funnel', ip: '127.0.0.1' };
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

describe('requireAdministrator middleware', () => {
  let requireAdministrator;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production'; // SHOULD_VERIFY_DB = true
    mock = createAdminPrincipalsSupabaseMock([baseRow()]);
    ({ requireAdministrator } = require('../requireAdministrator.middleware'));
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.ADMIN_HARDENING_ENABLED;
  });

  // ── Regression: auth / claim checks match old verifyAdmin ──────────────

  it('401s with no user (regression)', async () => {
    const req = makeReq(null);
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403 FORBIDDEN with no admin/super_admin claim, before any DB check (regression)', async () => {
    mock = createAdminPrincipalsSupabaseMock([]); // would fail if reached — proves claim check runs first
    const req = makeReq({ uid: 'user-1', role: 'contributor' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('a MASTER_ADMIN-only JWT claim is denied before any DB check (role boundary preserved, regression)', async () => {
    mock = createAdminPrincipalsSupabaseMock([]); // would fail if reached — proves claim check runs first
    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('recognizes admin via the roles[] array as well as role (regression)', async () => {
    const req = makeReq({ uid: 'admin-1', roles: ['admin'] });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // ── New: lifecycle enforcement ──────────────────────────────────────────

  it('calls next() and attaches req.adminPrincipal for an active admin', async () => {
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.adminPrincipal).toMatchObject({ uid: 'admin-1', status: 'active' });
  });

  it('calls next() for an active super_admin (regression parity: super_admin was always allowed)', async () => {
    mock.__setRows([baseRow({ uid: 'sa-1', role: 'super_admin' })]);
    const req = makeReq({ uid: 'sa-1', role: 'super_admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a suspended admin with ADMIN_SUSPENDED despite a valid JWT claim', async () => {
    mock.__setRows([baseRow({ status: 'suspended' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_SUSPENDED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a revoked admin with ADMIN_REVOKED despite a valid JWT claim', async () => {
    mock.__setRows([baseRow({ status: 'revoked' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_REVOKED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an expired admin with ADMIN_EXPIRED despite a valid JWT claim', async () => {
    mock.__setRows([baseRow({ status: 'expired' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_EXPIRED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an admin JWT with no backing admin_principals row', async () => {
    mock.__setRows([]);
    const req = makeReq({ uid: 'ghost-admin', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_SESSION_EXPIRED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('respects the 24h session TTL for admin (regression parity: admin never had MASTER_ADMIN\'s TTL bypass)', async () => {
    mock.__setRows([
      baseRow({ verified_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }),
    ]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ── Critical: no accidental broadening to MASTER_ADMIN ──────────────────

  it('denies an ACTIVE admin_principals row whose role is MASTER_ADMIN (no accidental broadening)', async () => {
    // Simulates a caller whose JWT happens to carry a role this guard
    // accepts, but whose authoritative admin_principals record is a
    // MASTER_ADMIN principal — must still be denied post-lifecycle-check,
    // matching the old verifyAdmin's exclusive admin/super_admin boundary.
    mock.__setRows([baseRow({ uid: 'admin-1', role: 'MASTER_ADMIN' })]);
    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) })
    );
  });

  // ── Non-hardened environments unaffected (regression) ────────────────────

  it('skips DB verification entirely outside production without the hardening flag (regression)', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.ADMIN_HARDENING_ENABLED;
    mock = createAdminPrincipalsSupabaseMock([]); // no row at all — would fail if DB-checked

    ({ requireAdministrator } = require('../requireAdministrator.middleware'));

    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('enforces DB verification outside production when ADMIN_HARDENING_ENABLED=true', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_HARDENING_ENABLED = 'true';
    mock = createAdminPrincipalsSupabaseMock([baseRow({ status: 'revoked' })]);

    ({ requireAdministrator } = require('../requireAdministrator.middleware'));

    const req = makeReq({ uid: 'admin-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdministrator(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_REVOKED' }) })
    );
  });
});
