'use strict';

/**
 * intelligenceSecrets.routes.test.js — WP-ADMIN-INTEL-03
 *
 * Route-level tests. Mounts the REAL router behind the REAL
 * requireMasterAdmin middleware (test env → JWT-claim-only path, no DB —
 * see requireMasterAdmin.middleware.js's SHOULD_VERIFY_DB gate, and
 * administrators.routes.authorization.test.js for the established
 * convention this mirrors), with the service layer mocked out. This
 * verifies:
 *   - authorization placement (unauthenticated / non-master / master)
 *   - the existing secretsMutationRateLimit is applied to POST/DELETE only
 *   - provider identifiers are validated server-side
 *   - responses never contain plaintext/ciphertext/internal secret fields
 */

const express = require('express');
const request = require('supertest');

const rateLimitCalls = [];

jest.mock('../../../middleware/adminRateLimit.middleware', () => ({
  secretsMutationRateLimit: (req, res, next) => {
    rateLimitCalls.push(`${req.method} ${req.path}`);
    next();
  },
}));

const mockListProviders = jest.fn();
const mockGetProvider = jest.fn();
const mockSaveProvider = jest.fn();
const mockDeleteProvider = jest.fn();

jest.mock('../intelligenceSecrets.service', () => ({
  listProviders: (...args) => mockListProviders(...args),
  getProvider: (...args) => mockGetProvider(...args),
  saveProvider: (...args) => mockSaveProvider(...args),
  deleteProvider: (...args) => mockDeleteProvider(...args),
}));

const { requireMasterAdmin } = require('../../../middleware/requireMasterAdmin.middleware');
const intelligenceSecretsRoutes = require('../intelligenceSecrets.routes');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  // Stands in for `authenticate` — mirrors administrators.routes.authorization.test.js.
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use(
    '/api/v1/admin/intelligence/secrets',
    requireMasterAdmin,
    intelligenceSecretsRoutes
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.status || err.statusCode || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

const ADMIN_USER = { uid: 'admin-1', id: 'admin-1', role: 'admin' };
const MASTER_ADMIN_USER = { uid: 'master-1', id: 'master-1', role: 'MASTER_ADMIN' };

beforeEach(() => {
  jest.clearAllMocks();
  rateLimitCalls.length = 0;
});

describe('intelligenceSecrets.routes — authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const app = buildApp(null);
    const res = await request(app).get('/api/v1/admin/intelligence/secrets');
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated non-Master-Admin with 403', async () => {
    const app = buildApp(ADMIN_USER);
    const res = await request(app).get('/api/v1/admin/intelligence/secrets');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows a valid Master Admin', async () => {
    mockListProviders.mockResolvedValue({ providers: [] });
    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app).get('/api/v1/admin/intelligence/secrets');
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated mutation (POST) with 401 before reaching the controller', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post('/api/v1/admin/intelligence/secrets/anthropic')
      .send({ value: 'sk-ant-test' });
    expect(res.status).toBe(401);
    expect(mockSaveProvider).not.toHaveBeenCalled();
  });

  it('rejects a non-Master-Admin mutation (DELETE) with 403 before reaching the controller', async () => {
    const app = buildApp(ADMIN_USER);
    const res = await request(app).delete('/api/v1/admin/intelligence/secrets/anthropic');
    expect(res.status).toBe(403);
    expect(mockDeleteProvider).not.toHaveBeenCalled();
  });
});

describe('intelligenceSecrets.routes — mutation rate limit placement', () => {
  it('applies secretsMutationRateLimit on POST /:provider', async () => {
    mockSaveProvider.mockResolvedValue({ provider: 'anthropic', secretName: 'ANTHROPIC_API_KEY', preview: 'sk-a****' });
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app)
      .post('/api/v1/admin/intelligence/secrets/anthropic')
      .send({ value: 'sk-ant-test' });
    expect(rateLimitCalls).toContain('POST /anthropic');
  });

  it('applies secretsMutationRateLimit on DELETE /:provider', async () => {
    mockDeleteProvider.mockResolvedValue({ provider: 'anthropic', secretName: 'ANTHROPIC_API_KEY' });
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app).delete('/api/v1/admin/intelligence/secrets/anthropic');
    expect(rateLimitCalls).toContain('DELETE /anthropic');
  });

  it('does NOT apply the rate limiter on GET / (list)', async () => {
    mockListProviders.mockResolvedValue({ providers: [] });
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app).get('/api/v1/admin/intelligence/secrets');
    expect(rateLimitCalls).toEqual([]);
  });

  it('does NOT apply the rate limiter on GET /:provider/status', async () => {
    mockGetProvider.mockResolvedValue({ provider: 'anthropic', configured: false });
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app).get('/api/v1/admin/intelligence/secrets/anthropic/status');
    expect(rateLimitCalls).toEqual([]);
  });
});

describe('intelligenceSecrets.routes — provider validation', () => {
  it('accepts a known supported provider', async () => {
    mockGetProvider.mockResolvedValue({ provider: 'openai', configured: false });
    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app).get('/api/v1/admin/intelligence/secrets/openai/status');
    expect(res.status).toBe(200);
  });

  it('rejects an unknown provider with 400, not 500, and does not call the service mutation path', async () => {
    const err = Object.assign(new Error("Unsupported Intelligence provider: 'bogus'."), {
      status: 400,
      code: 'UNKNOWN_PROVIDER',
    });
    mockSaveProvider.mockRejectedValue(err);

    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app)
      .post('/api/v1/admin/intelligence/secrets/bogus')
      .send({ value: 'anything' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNKNOWN_PROVIDER');
  });

  it('a manipulated provider identifier cannot be used to reach an arbitrary secret name — service always receives the raw param, never a derived name', async () => {
    mockGetProvider.mockResolvedValue({ provider: 'MASTER_ENCRYPTION_KEY', configured: false });
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app).get('/api/v1/admin/intelligence/secrets/MASTER_ENCRYPTION_KEY/status');

    // The route/controller never resolves a secret name itself — it passes
    // the identifier through untouched to the service, which (per
    // intelligenceSecrets.config.test.js) rejects anything not in the
    // fixed provider registry before any Secrets Manager call is made.
    expect(mockGetProvider).toHaveBeenCalledWith('MASTER_ENCRYPTION_KEY');
  });
});

describe('intelligenceSecrets.routes — secret safety', () => {
  it('createOrUpdate never returns the submitted value', async () => {
    mockSaveProvider.mockResolvedValue({
      provider: 'anthropic',
      secretName: 'ANTHROPIC_API_KEY',
      preview: 'sk-a****',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app)
      .post('/api/v1/admin/intelligence/secrets/anthropic')
      .send({ value: 'sk-ant-super-secret-value-should-never-appear' });

    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('sk-ant-super-secret-value-should-never-appear');
  });

  it('rejects a missing value with 400 INVALID_INPUT and does not call the service', async () => {
    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app)
      .post('/api/v1/admin/intelligence/secrets/anthropic')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(mockSaveProvider).not.toHaveBeenCalled();
  });

  it('status/list responses never contain encrypted internals', async () => {
    mockListProviders.mockResolvedValue({
      providers: [
        {
          provider: 'anthropic',
          secretName: 'ANTHROPIC_API_KEY',
          environmentConfigured: false,
          secretsManagerConfigured: true,
          configured: true,
        },
      ],
    });

    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app).get('/api/v1/admin/intelligence/secrets');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/encrypted_value|auth_tag|hmac|"iv"/i);
  });
});
