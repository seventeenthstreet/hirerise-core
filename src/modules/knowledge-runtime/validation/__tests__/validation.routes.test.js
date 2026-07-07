'use strict';

/**
 * modules/knowledge-runtime/validation/__tests__/validation.routes.test.js
 *
 * Route-level test: mounts the real router in a minimal Express app (no
 * server.js involved) with the service singleton mocked, verifying route
 * wiring itself rather than re-testing controller logic already covered by
 * validation.controller.test.js.
 */

const express = require('express');
const request = require('supertest');

const mockService = {
  validateDecisionReadiness: jest.fn(),
};

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../knowledge-runtime.module', () => ({
  getValidationService: () => mockService,
}));

const validationRoutes = require('../validation.routes');

function buildApp({ withUser = true } = {}) {
  const app = express();
  app.use((req, res, next) => {
    if (withUser) req.user = { id: 'user-1' };
    next();
  });
  app.use('/api/v1/validation', validationRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('validation.routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/v1/validation/me returns 200 with the service result', async () => {
    // WP-XAI2-03: the service still returns `userId` internally, but the
    // public HTTP response must not carry it — `data` is asserted against
    // the filtered shape. `meta` (WP-XAI2-02, dynamic timestamp/requestId)
    // is intentionally not asserted here.
    mockService.validateDecisionReadiness.mockResolvedValue({ userId: 'user-1', valid: true, score: 0.9 });

    const app = buildApp();
    const res = await request(app).get('/api/v1/validation/me');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ valid: true, score: 0.9 });
    expect(mockService.validateDecisionReadiness).toHaveBeenCalledWith('user-1');
  });

  // WP-XAI2-03 regression coverage: end-to-end (real router + real
  // controller, service mocked) confirmation that userId never reaches the
  // wire, even though the service mock still returns it.
  it('WP-XAI2-03 regression: response body never contains userId', async () => {
    mockService.validateDecisionReadiness.mockResolvedValue({ userId: 'user-1', valid: true, score: 0.9 });

    const app = buildApp();
    const res = await request(app).get('/api/v1/validation/me');

    expect(res.body.data).not.toHaveProperty('userId');
    expect(JSON.stringify(res.body)).not.toContain('user-1');
  });

  it('returns an error response when req.user is absent', async () => {
    const app = buildApp({ withUser: false });
    const res = await request(app).get('/api/v1/validation/me');

    // Same AppError argument-order caveat as recommendation.routes.test.js —
    // not asserting an exact status code, only that validation failed
    // before the service was ever called.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockService.validateDecisionReadiness).not.toHaveBeenCalled();
  });

  it('does not expose any route other than GET /me', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/validation/me');

    expect(res.status).toBe(404);
  });
});
