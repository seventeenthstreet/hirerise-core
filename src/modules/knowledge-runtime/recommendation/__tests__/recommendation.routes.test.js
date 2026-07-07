'use strict';

/**
 * modules/knowledge-runtime/recommendation/__tests__/recommendation.routes.test.js
 *
 * Route-level test: mounts the real router in a minimal Express app (no
 * server.js involved) with the service singleton mocked, verifying the
 * route wiring itself (path, method, middleware order) rather than
 * re-testing controller logic already covered by
 * recommendation.controller.test.js.
 */

const express = require('express');
const request = require('supertest');

const mockService = {
  generateRecommendationCandidates: jest.fn(),
};

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../knowledge-runtime.module', () => ({
  getRecommendationService: () => mockService,
}));

const recommendationRoutes = require('../recommendation.routes');

function buildApp({ withUser = true } = {}) {
  const app = express();
  app.use((req, res, next) => {
    if (withUser) req.user = { id: 'user-1' };
    next();
  });
  app.use('/api/v1/recommendations', recommendationRoutes);
  // Minimal error handler so thrown AppErrors resolve to a real HTTP response
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('recommendation.routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/v1/recommendations/me returns 200 with the service result', async () => {
    // WP-XAI2-03: the service still returns `userId` internally, but the
    // public HTTP response must not carry it — `data` is asserted against
    // the filtered shape. `meta` (WP-XAI2-02, dynamic timestamp/requestId)
    // is intentionally not asserted here.
    mockService.generateRecommendationCandidates.mockResolvedValue({
      userId: 'user-1',
      skillRecommendations: { available: true, candidates: [] },
    });

    const app = buildApp();
    const res = await request(app).get('/api/v1/recommendations/me');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ skillRecommendations: { available: true, candidates: [] } });
    expect(mockService.generateRecommendationCandidates).toHaveBeenCalledWith('user-1', { groups: null });
  });

  // WP-XAI2-03 regression coverage: end-to-end (real router + real
  // controller, service mocked) confirmation that userId never reaches the
  // wire, even though the service mock still returns it.
  it('WP-XAI2-03 regression: response body never contains userId', async () => {
    mockService.generateRecommendationCandidates.mockResolvedValue({
      userId: 'user-1',
      skillRecommendations: { available: true, candidates: [] },
    });

    const app = buildApp();
    const res = await request(app).get('/api/v1/recommendations/me');

    expect(res.body.data).not.toHaveProperty('userId');
    expect(JSON.stringify(res.body)).not.toContain('user-1');
  });

  it('GET /api/v1/recommendations/me?groups=skill passes the parsed groups through', async () => {
    mockService.generateRecommendationCandidates.mockResolvedValue({ userId: 'user-1' });

    const app = buildApp();
    await request(app).get('/api/v1/recommendations/me?groups=skill');

    expect(mockService.generateRecommendationCandidates).toHaveBeenCalledWith('user-1', { groups: ['skill'] });
  });

  it('returns an error response when req.user is absent', async () => {
    const app = buildApp({ withUser: false });
    const res = await request(app).get('/api/v1/recommendations/me');

    // Not asserting an exact status code here: AppError's constructor has a
    // documented argument-order quirk (see documents/WP-IMP-02/IMPLEMENTATION_NOTES.md)
    // that this WP doesn't fix, so the exact resolved statusCode isn't a
    // stable contract to test against. What matters for this route test is
    // that validation failed before the service was ever called.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockService.generateRecommendationCandidates).not.toHaveBeenCalled();
  });

  it('does not expose any route other than GET /me', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/recommendations/me');

    // No POST handler registered for /me — Express falls through to no
    // matching route (404), since this router defines GET only.
    expect(res.status).toBe(404);
  });
});
