'use strict';

/**
 * requireEditor.middleware.test.js — WP-ADMIN-04G
 *
 * Mirrors the shape of requireContributor.middleware.js's own behavior
 * (no dedicated test file existed for that middleware in this repo to
 * copy from, so these tests are written directly against the documented
 * contract in requireEditor.middleware.js's doc comment).
 */

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { requireEditor } = require('../requireEditor.middleware');

function makeReq(user) {
  return { user, headers: {}, originalUrl: '/api/v1/admin/editorial/some-resource', ip: '127.0.0.1' };
}

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('requireEditor middleware (WP-ADMIN-04G)', () => {
  it('rejects an unauthenticated request with 401', () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = jest.fn();

    requireEditor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a user whose role is editor', () => {
    const req = makeReq({ role: 'editor', roles: ['editor'] });
    const res = makeRes();
    const next = jest.fn();

    requireEditor(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a user whose role is contributor', () => {
    const req = makeReq({ role: 'contributor', roles: ['contributor'] });
    const res = makeRes();
    const next = jest.fn();

    requireEditor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a plain user', () => {
    const req = makeReq({ role: 'user', roles: ['user'] });
    const res = makeRes();
    const next = jest.fn();

    requireEditor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['admin', 'super_admin', 'MASTER_ADMIN'])(
    'allows an Administrator role (%s) via escalation',
    (adminRole) => {
      const req = makeReq({ role: adminRole, roles: [adminRole] });
      const res = makeRes();
      const next = jest.fn();

      requireEditor(req, res, next);

      expect(next).toHaveBeenCalled();
    }
  );

  it('allows via the roles[] array even when role is not editor', () => {
    const req = makeReq({ role: 'user', roles: ['user', 'editor'] });
    const res = makeRes();
    const next = jest.fn();

    requireEditor(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('allows via the admin boolean flag regardless of role string', () => {
    const req = makeReq({ role: 'user', roles: ['user'], admin: true });
    const res = makeRes();
    const next = jest.fn();

    requireEditor(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
