'use strict';

/**
 * intelligenceConfig.routes.test.js — WP-ADMIN-INTEL-04
 *
 * Mirrors intelligenceSecrets.routes.test.js's approach: mounts the REAL
 * router behind the REAL requireMasterAdmin middleware, service layer
 * mocked out. Verifies:
 *   - authorization placement (unauthenticated / non-master / master)
 *   - intelligenceConfigMutationRateLimit is applied to PUT/DELETE only
 *   - unknown keys are rejected with 400, not 500
 */

const express = require('express');
const request = require('supertest');

const rateLimitCalls = [];

jest.mock('../../../middleware/adminRateLimit.middleware', () => ({
  intelligenceConfigMutationRateLimit: (req, res, next) => {
    rateLimitCalls.push(`${req.method} ${req.path}`);
    next();
  },
}));

const mockListSettings = jest.fn();
const mockGetSetting = jest.fn();
const mockUpdateSetting = jest.fn();
const mockResetSetting = jest.fn();

jest.mock('../intelligenceConfig.service', () => ({
  listSettings: (...args) => mockListSettings(...args),
  getSetting: (...args) => mockGetSetting(...args),
  updateSetting: (...args) => mockUpdateSetting(...args),
  resetSetting: (...args) => mockResetSetting(...args),
}));

const { requireMasterAdmin } = require('../../../middleware/requireMasterAdmin.middleware');
const intelligenceConfigRoutes = require('../intelligenceConfig.routes');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use(
    '/api/v1/admin/intelligence/config',
    requireMasterAdmin,
    intelligenceConfigRoutes
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

describe('intelligenceConfig.routes — authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const app = buildApp(null);
    const res = await request(app).get('/api/v1/admin/intelligence/config');
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated non-Master-Admin with 403', async () => {
    const app = buildApp(ADMIN_USER);
    const res = await request(app).get('/api/v1/admin/intelligence/config');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows a valid Master Admin', async () => {
    mockListSettings.mockResolvedValue([]);
    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app).get('/api/v1/admin/intelligence/config');
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated mutation (PUT) with 401 before reaching the controller', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .put('/api/v1/admin/intelligence/config/AI_PROVIDER_PRIORITY')
      .send({ value: 'gemini,openai' });
    expect(res.status).toBe(401);
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it('rejects a non-Master-Admin mutation (DELETE) with 403 before reaching the controller', async () => {
    const app = buildApp(ADMIN_USER);
    const res = await request(app).delete('/api/v1/admin/intelligence/config/AI_PROVIDER_PRIORITY');
    expect(res.status).toBe(403);
    expect(mockResetSetting).not.toHaveBeenCalled();
  });
});

describe('intelligenceConfig.routes — mutation rate limit placement', () => {
  it('applies intelligenceConfigMutationRateLimit on PUT /:key', async () => {
    mockUpdateSetting.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'gemini,openai', source: 'admin' });
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app)
      .put('/api/v1/admin/intelligence/config/AI_PROVIDER_PRIORITY')
      .send({ value: 'gemini,openai' });
    expect(rateLimitCalls).toContain('PUT /AI_PROVIDER_PRIORITY');
  });

  it('applies intelligenceConfigMutationRateLimit on DELETE /:key', async () => {
    mockResetSetting.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'gemini,grok,mistral,openai,anthropic', source: 'default' });
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app).delete('/api/v1/admin/intelligence/config/AI_PROVIDER_PRIORITY');
    expect(rateLimitCalls).toContain('DELETE /AI_PROVIDER_PRIORITY');
  });

  it('does NOT apply the rate limiter on GET / (list)', async () => {
    mockListSettings.mockResolvedValue([]);
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app).get('/api/v1/admin/intelligence/config');
    expect(rateLimitCalls).toEqual([]);
  });

  it('does NOT apply the rate limiter on GET /:key', async () => {
    mockGetSetting.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'gemini', source: 'default' });
    const app = buildApp(MASTER_ADMIN_USER);
    await request(app).get('/api/v1/admin/intelligence/config/AI_PROVIDER_PRIORITY');
    expect(rateLimitCalls).toEqual([]);
  });
});

describe('intelligenceConfig.routes — key validation', () => {
  it('rejects an unknown key with 400, not 500', async () => {
    const err = Object.assign(new Error("Unsupported Intelligence configuration key: 'BOGUS'."), {
      status: 400,
      code: 'UNKNOWN_CONFIG_KEY',
    });
    mockGetSetting.mockRejectedValue(err);
    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app).get('/api/v1/admin/intelligence/config/BOGUS');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNKNOWN_CONFIG_KEY');
  });

  it('rejects a PUT with no value with 400 before calling the service', async () => {
    const app = buildApp(MASTER_ADMIN_USER);
    const res = await request(app)
      .put('/api/v1/admin/intelligence/config/AI_PROVIDER_PRIORITY')
      .send({});
    expect(res.status).toBe(400);
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });
});
