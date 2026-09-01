'use strict';

/**
 * adminRateLimit.secretsMutation.test.js — WP-ADMIN-INTEL-02
 *
 * Verifies secretsMutationRateLimit — the correction for the verified
 * documentation/implementation mismatch on the Secrets Manager mutation
 * rate limit (server.js documented "10 requests/hour/admin UID"; nothing
 * enforced it). Reuses the existing, already-hardened createRateLimiter()
 * factory (RPC-backed with fail-closed Redis fallback) — same behavior
 * contract as adminRateLimit/masterRateLimit, just a new limit/window
 * matching the documented figure.
 */

let mockRpc;
let mockRedisIncr;

jest.mock('../../config/supabase', () => ({
  get supabase() {
    return { rpc: (...args) => mockRpc(...args) };
  },
}));

jest.mock('../../config/redisClient', () => ({
  get incr() {
    return (...args) => mockRedisIncr(...args);
  },
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

function makeReq(user) {
  return { user, ip: '127.0.0.1' };
}

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('secretsMutationRateLimit (WP-ADMIN-INTEL-02)', () => {
  let secretsMutationRateLimit;

  beforeEach(() => {
    jest.resetModules();
    mockRpc = jest.fn();
    mockRedisIncr = jest.fn();
    ({ secretsMutationRateLimit } = require('../adminRateLimit.middleware'));
  });

  it('is configured for 10 requests per hour (matches the documented contract)', async () => {
    mockRpc.mockImplementation((_fn, params) => {
      expect(params.p_limit).toBe(10);
      expect(params.p_window_seconds).toBe(60 * 60);
      expect(params.p_key).toBe('secrets-mutation:admin-1');
      return Promise.resolve({ data: true, error: null });
    });

    const req = makeReq({ uid: 'admin-1' });
    const res = makeRes();
    const next = jest.fn();

    await secretsMutationRateLimit(req, res, next);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows the request when under the limit', async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    const req = makeReq({ id: 'admin-2' });
    const res = makeRes();
    const next = jest.fn();

    await secretsMutationRateLimit(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('rejects with 429 RATE_LIMIT_EXCEEDED once the RPC reports the limit exceeded', async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });

    const req = makeReq({ uid: 'admin-3' });
    const res = makeRes();
    const next = jest.fn();

    await secretsMutationRateLimit(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }) })
    );
  });

  it('fails closed via the Redis fallback (denies) when both the RPC and Redis are unavailable', async () => {
    mockRpc.mockRejectedValue(new Error('rpc unreachable'));
    mockRedisIncr.mockRejectedValue(new Error('redis unreachable'));

    const req = makeReq({ uid: 'admin-4' });
    const res = makeRes();
    const next = jest.fn();

    await secretsMutationRateLimit(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('never includes secret values in its own responses', async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });

    const req = makeReq({ uid: 'admin-5' });
    const res = makeRes();
    const next = jest.fn();

    await secretsMutationRateLimit(req, res, next);

    const payload = JSON.stringify(res.json.mock.calls[0][0]);
    expect(payload).not.toMatch(/sk-|api[_-]?key|secret[_-]?value/i);
  });
});
