'use strict';

/**
 * requireMasterAdmin.middleware.test.js — WP-ADMIN-INTEL-02
 *
 * Covers:
 *  - Regression: unauthenticated (401) and no-claim (403 FORBIDDEN) checks
 *    are unchanged and still short-circuit before any DB call.
 *  - New lifecycle enforcement: a valid MASTER_ADMIN JWT claim is no
 *    longer sufficient on its own — the backing admin_principals row must
 *    also be status='active'. Suspended/revoked/expired/missing principals
 *    are rejected with the same error codes requireAdmin.middleware.js
 *    already uses for the equivalent states.
 *  - MASTER_ADMIN's existing 24h session-TTL bypass (from
 *    adminPrincipal.repository.js#verify) is preserved.
 *  - Non-hardened environments (no NODE_ENV=production, no
 *    ADMIN_HARDENING_ENABLED) are unaffected — matches
 *    administrators.routes.authorization.test.js's existing assumption
 *    that "the real requireMasterAdmin only reads req.user" in that mode.
 *  - No secret values anywhere in these fixtures/assertions (N/A — this
 *    middleware never touches secrets, only admin_principals lifecycle).
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
  return { user, headers: {}, originalUrl: '/api/v1/admin/secrets', ip: '127.0.0.1' };
}

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function baseRow(overrides = {}) {
  return {
    uid: 'master-1',
    role: 'MASTER_ADMIN',
    status: 'active',
    verified_at: new Date().toISOString(),
    last_action_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('requireMasterAdmin middleware', () => {
  let requireMasterAdmin;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production'; // SHOULD_VERIFY_DB = true
    mock = createAdminPrincipalsSupabaseMock([baseRow()]);
    ({ requireMasterAdmin } = require('../requireMasterAdmin.middleware'));
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

    await requireMasterAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403 FORBIDDEN with no MASTER_ADMIN claim, before any DB check (regression)', async () => {
    mock = createAdminPrincipalsSupabaseMock([]); // would fail if reached — proves claim check runs first
    const req = makeReq({ uid: 'user-1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('recognizes MASTER_ADMIN via the roles[] array as well as role (regression)', async () => {
    const req = makeReq({ uid: 'master-1', roles: ['MASTER_ADMIN'] });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // ── New: lifecycle enforcement ──────────────────────────────────────────

  it('calls next() and attaches req.adminPrincipal for an active MASTER_ADMIN', async () => {
    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.adminPrincipal).toMatchObject({ uid: 'master-1', status: 'active' });
  });

  it('rejects a suspended MASTER_ADMIN with ADMIN_SUSPENDED despite a valid JWT claim', async () => {
    mock.__setRows([baseRow({ status: 'suspended' })]);
    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_SUSPENDED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a revoked MASTER_ADMIN with ADMIN_REVOKED despite a valid JWT claim', async () => {
    mock.__setRows([baseRow({ status: 'revoked' })]);
    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_REVOKED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an expired MASTER_ADMIN with ADMIN_EXPIRED despite a valid JWT claim', async () => {
    mock.__setRows([baseRow({ status: 'expired' })]);
    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_EXPIRED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a MASTER_ADMIN JWT with no backing admin_principals row (missing/mismatched authority record)', async () => {
    mock.__setRows([]); // JWT claims MASTER_ADMIN but no row exists at all
    const req = makeReq({ uid: 'ghost-master', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_SESSION_EXPIRED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('a MASTER_ADMIN JWT claim with an inactive DB lifecycle state is rejected even though the JWT alone would have passed the old check', async () => {
    // This is the exact drift scenario G1/G3 raised: JWT still says
    // MASTER_ADMIN, but the authoritative admin_principals record has
    // been suspended since the JWT was issued.
    mock.__setRows([baseRow({ status: 'suspended' })]);
    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN', roles: ['MASTER_ADMIN'] });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ── Regression: MASTER_ADMIN 24h TTL bypass preserved ───────────────────

  it('MASTER_ADMIN still bypasses the 24h session TTL (regression) but not lifecycle status', async () => {
    mock.__setRows([
      baseRow({ verified_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }),
    ]);
    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // ── Non-hardened environments unaffected (regression) ───────────────────

  it('skips DB verification entirely outside production without the hardening flag (regression)', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.ADMIN_HARDENING_ENABLED;
    mock = createAdminPrincipalsSupabaseMock([]); // no row at all — would fail if DB-checked

    ({ requireMasterAdmin } = require('../requireMasterAdmin.middleware'));

    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('enforces DB verification outside production when ADMIN_HARDENING_ENABLED=true', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_HARDENING_ENABLED = 'true';
    mock = createAdminPrincipalsSupabaseMock([baseRow({ status: 'revoked' })]);

    ({ requireMasterAdmin } = require('../requireMasterAdmin.middleware'));

    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ADMIN_REVOKED' }) })
    );
  });

  // ── No secret values anywhere ────────────────────────────────────────────

  it('never includes secret-shaped values in any response payload', async () => {
    mock.__setRows([baseRow({ status: 'revoked' })]);
    const req = makeReq({ uid: 'master-1', role: 'MASTER_ADMIN' });
    const res = makeRes();
    const next = jest.fn();

    await requireMasterAdmin(req, res, next);

    const allJsonCalls = res.json.mock.calls.map((c) => JSON.stringify(c[0]));
    for (const payload of allJsonCalls) {
      expect(payload).not.toMatch(/sk-|api[_-]?key|secret[_-]?value/i);
    }
  });
});
