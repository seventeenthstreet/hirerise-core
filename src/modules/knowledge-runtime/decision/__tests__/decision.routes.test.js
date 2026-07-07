'use strict';

/**
 * modules/knowledge-runtime/decision/__tests__/decision.routes.test.js
 *
 * Route-level test: mounts the real router in a minimal Express app (no
 * server.js involved) with the service singleton mocked, verifying route
 * wiring itself rather than re-testing controller logic already covered by
 * decision.controller.test.js.
 */

const express = require('express');
const request = require('supertest');

const mockService = {
  decide: jest.fn(),
};

const mockExplainabilityService = {
  // WP-IMP-06: decision.controller.js now also calls
  // getExplainabilityService().explain(decision) and attaches the result
  // as data.explanation — see decision.controller.test.js for dedicated
  // coverage of that behavior. Here it's mocked as a passthrough so this
  // route-level test keeps testing routing/validation, not explainability.
  explain: jest.fn((decision) => ({ decisionId: decision.decisionId, headline: 'mock-headline' })),
};

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../knowledge-runtime.module', () => ({
  getDecisionService: () => mockService,
  getExplainabilityService: () => mockExplainabilityService,
}));

const decisionRoutes = require('../decision.routes');

function buildApp({ withUser = true } = {}) {
  const app = express();
  app.use((req, res, next) => {
    if (withUser) req.user = { id: 'user-1' };
    next();
  });
  app.use('/api/v1/decisions', decisionRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('decision.routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/v1/decisions/me?decisionType=skill returns 200 with the service result', async () => {
    mockService.decide.mockResolvedValue({ decisionId: 'DEC-1', status: 'DECISION_READY' });

    const app = buildApp();
    const res = await request(app).get('/api/v1/decisions/me').query({ decisionType: 'skill' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        decisionId: 'DEC-1',
        status: 'DECISION_READY',
        explanation: { decisionId: 'DEC-1', headline: 'mock-headline' },
      },
    });
    expect(mockService.decide).toHaveBeenCalledWith('user-1', 'skill');
  });

  it('GET /api/v1/decisions/me for a non-skill decisionType still returns 200 with a WITHHELD-shaped result', async () => {
    mockService.decide.mockResolvedValue({ decisionId: 'DEC-2', status: 'WITHHELD' });

    const app = buildApp();
    const res = await request(app).get('/api/v1/decisions/me').query({ decisionType: 'career' });

    expect(res.status).toBe(200);
    expect(mockService.decide).toHaveBeenCalledWith('user-1', 'career');
  });

  it('returns an error response when decisionType is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/decisions/me');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockService.decide).not.toHaveBeenCalled();
  });

  it('returns an error response when req.user is absent', async () => {
    const app = buildApp({ withUser: false });
    const res = await request(app).get('/api/v1/decisions/me').query({ decisionType: 'skill' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockService.decide).not.toHaveBeenCalled();
  });

  it('does not expose any route other than GET /me', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/decisions/me');

    expect(res.status).toBe(404);
  });
});
