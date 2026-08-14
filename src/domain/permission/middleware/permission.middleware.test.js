'use strict';

/**
 * @file src/domain/permission/middleware/__tests__/permission.middleware.test.js
 *
 * WP-ADMIN-04F-07 — Enterprise Authorization Middleware
 * (fakes updated under WP-ADMIN-04F-10 — Role ↔ Permission Integration:
 * the middleware now consumes a Permission Grant Resolver instead of
 * composing an Assignment Service directly — see permission.middleware.js's
 * header.)
 *
 * Exercises `requirePermission()` against fake, constructor-injected
 * Grant Resolver and Evaluation Engine collaborators — mirrors
 * ../../assignment/__tests__/permission.assignment.service.test.js's own
 * "fake satisfying the method surface" convention. No Supabase access,
 * no HTTP integration, no Express routing — req/res/next are plain
 * mocks per the WP's Testing section.
 */

const { RESOURCES, ACTIONS, AUTHORIZATION_DECISIONS } = require('../permission.constants');
const {
  PermissionNotFoundError,
  PermissionNotEvaluableError,
} = require('../evaluation/permission.evaluation.errors');
const { requirePermission } = require('./permission.middleware');
const {
  AuthorizationConfigurationError,
  AuthorizationMiddlewareError,
} = require('./permission.middleware.errors');

const RESOURCE = RESOURCES.JOB_LISTING;
const ACTION = ACTIONS.VIEW;

function makeDecision(outcome, reason = 'because') {
  return { outcome, reason };
}

function makeFakeEvaluationEngine({ decision, error } = {}) {
  return {
    async evaluate() {
      if (error) throw error;
      return { decision: decision ?? makeDecision(AUTHORIZATION_DECISIONS.ALLOW), explanation: {} };
    },
  };
}

function makeFakeGrantResolver({ hasGrant = true, error } = {}) {
  return {
    async hasGrant() {
      if (error) throw error;
      return hasGrant;
    },
  };
}

function makeReq(overrides = {}) {
  return { user: { id: 'user-1', uid: 'user-1' }, requestId: 'req-1', ...overrides };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requirePermission() — configuration', () => {
  it('throws AuthorizationConfigurationError for an invalid resource', () => {
    expect(() => requirePermission('not-a-resource', ACTION)).toThrow(AuthorizationConfigurationError);
  });

  it('throws AuthorizationConfigurationError for an invalid action', () => {
    expect(() => requirePermission(RESOURCE, 'not-an-action')).toThrow(AuthorizationConfigurationError);
  });

  it('throws AuthorizationConfigurationError for malformed injected dependencies', () => {
    expect(() =>
      requirePermission(RESOURCE, ACTION, { evaluationEngine: {}, grantResolver: {} }),
    ).toThrow(AuthorizationConfigurationError);
  });

  it('returns an Express middleware function when configured correctly', () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine(),
      grantResolver: makeFakeGrantResolver(),
    });
    expect(typeof middleware).toBe('function');
    expect(middleware.length).toBe(3); // (req, res, next)
  });
});

describe('requirePermission() — authorized request', () => {
  it('calls next() with no arguments when Evaluation Allows and a Grant exists', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine({ decision: makeDecision(AUTHORIZATION_DECISIONS.ALLOW) }),
      grantResolver: makeFakeGrantResolver({ hasGrant: true }),
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('preserves the existing request object — does not mutate req.user', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine(),
      grantResolver: makeFakeGrantResolver({ hasGrant: true }),
    });
    const req = makeReq();
    const originalUser = req.user;
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(req.user).toBe(originalUser);
  });

  it('extracts the authenticated user id and role and passes them to Evaluation and the Grant Resolver', async () => {
    const evaluate = jest.fn().mockResolvedValue({ decision: makeDecision(AUTHORIZATION_DECISIONS.ALLOW), explanation: {} });
    const hasGrant = jest.fn().mockResolvedValue(true);
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: { evaluate },
      grantResolver: { hasGrant },
    });
    const req = makeReq({ user: { id: 'user-42', role: 'contributor' } });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(evaluate).toHaveBeenCalledWith({ userId: 'user-42', resource: RESOURCE, action: ACTION });
    expect(hasGrant).toHaveBeenCalledWith({ principalId: 'user-42', role: 'contributor', resource: RESOURCE, action: ACTION });
    expect(next).toHaveBeenCalledWith();
  });

  it('passes a null role to the Grant Resolver when req.user has no resolvable role', async () => {
    const hasGrant = jest.fn().mockResolvedValue(true);
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine(),
      grantResolver: { hasGrant },
    });
    const req = makeReq({ user: { id: 'user-42' } });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(hasGrant).toHaveBeenCalledWith({ principalId: 'user-42', role: null, resource: RESOURCE, action: ACTION });
  });
});

describe('requirePermission() — unauthorized request (missing/invalid user)', () => {
  it('responds 401 when req.user is absent', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine(),
      grantResolver: makeFakeGrantResolver(),
    });
    const req = makeReq({ user: undefined });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'UNAUTHORIZED' }) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when req.user has no resolvable id', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine(),
      grantResolver: makeFakeGrantResolver(),
    });
    const req = makeReq({ user: {} });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requirePermission() — Evaluation Deny outcomes', () => {
  it('responds 403 when Evaluation resolves Deny (e.g. a retired permission)', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine({
        decision: makeDecision(AUTHORIZATION_DECISIONS.DENY, 'retired'),
      }),
      grantResolver: makeFakeGrantResolver({ hasGrant: true }),
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'FORBIDDEN', message: 'retired' }) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 403 when Evaluation throws PermissionNotFoundError (invalid/unknown permission)', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine({ error: new PermissionNotFoundError(`${RESOURCE}:${ACTION}`) }),
      grantResolver: makeFakeGrantResolver(),
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 403 when Evaluation throws PermissionNotEvaluableError', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine({
        error: new PermissionNotEvaluableError(`${RESOURCE}:${ACTION}`, 'proposed'),
      }),
      grantResolver: makeFakeGrantResolver(),
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requirePermission() — missing grant', () => {
  it('responds 403 when Evaluation Allows but the Principal has no Grant (explicit or Role-derived)', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine({ decision: makeDecision(AUTHORIZATION_DECISIONS.ALLOW) }),
      grantResolver: makeFakeGrantResolver({ hasGrant: false }),
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requirePermission() — unexpected/malformed failures', () => {
  it('passes an unexpected Evaluation Engine error to next() rather than sending a response', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine({ error: new Error('database exploded') }),
      grantResolver: makeFakeGrantResolver(),
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const forwardedError = next.mock.calls[0][0];
    expect(forwardedError).toBeInstanceOf(AuthorizationMiddlewareError);
    expect(forwardedError.statusCode).toBe(500);
  });

  it('passes an unexpected Grant Resolver error to next() rather than sending a response', async () => {
    const middleware = requirePermission(RESOURCE, ACTION, {
      evaluationEngine: makeFakeEvaluationEngine({ decision: makeDecision(AUTHORIZATION_DECISIONS.ALLOW) }),
      grantResolver: makeFakeGrantResolver({ error: new Error('repository unavailable') }),
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(AuthorizationMiddlewareError);
  });
});
