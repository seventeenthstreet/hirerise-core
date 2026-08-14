'use strict';

/**
 * @file responseEnvelope.test.js
 * @description
 * WP-ADMIN-COMP-02 — API contract reconciliation.
 *
 * GET /api/v1/metrics/xai-usage, /xai-tier, and GET /api/v1/system/health
 * previously returned their payload directly (no envelope). The frontend's
 * apiRequest() parser enforces a canonical { success: true, data } envelope
 * (the "R1 rule") on every response and treats anything else as a failure --
 * so every successful 200 from these endpoints was being surfaced to
 * useXaiMetrics()/useXaiDashboard()/useSystemHealth() as an error.
 *
 * These tests assert the canonical envelope is now present, matching the
 * contract every other reconciled Admin endpoint already follows (see
 * src/shared/response/index.js#sendSuccess and ai-observability.routes.js).
 */

const express = require('express');
const request = require('supertest');

function buildApp(router) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { role: 'admin' };
    next();
  });
  app.use('/', router);
  return app;
}

describe('Admin response envelope reconciliation (WP-ADMIN-COMP-02)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('GET /xai-usage returns { success: true, data } instead of the raw metrics object', async () => {
    jest.doMock('../../../services/xaiMetrics.service', () => ({
      getUsageMetrics: jest.fn().mockResolvedValue({ explanation_request_count: 5 }),
      getTierDistribution: jest.fn(),
    }));

    const router = require('../xaiMetrics.routes');
    const app = buildApp(router);

    const res = await request(app).get('/xai-usage');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { explanation_request_count: 5 },
    });
  });

  test('GET /xai-tier returns { success: true, data } instead of the raw metrics object', async () => {
    jest.doMock('../../../services/xaiMetrics.service', () => ({
      getUsageMetrics: jest.fn(),
      getTierDistribution: jest.fn().mockResolvedValue({ free_tier_count: 3 }),
    }));

    const router = require('../xaiMetrics.routes');
    const app = buildApp(router);

    const res = await request(app).get('/xai-tier');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { free_tier_count: 3 },
    });
  });

  test('GET /system/health returns { success: true, data } instead of the raw health object', async () => {
    jest.doMock('../../../services/admin/systemHealth.service', () => ({
      getSystemHealthStatus: jest.fn().mockResolvedValue({
        status: 'healthy',
        environment: 'test',
        build_version: '1.0.0',
        error_rate_24h: 0,
        checked_at: '2026-01-01T00:00:00.000Z',
      }),
    }));

    const router = require('../systemHealth.routes');
    const app = buildApp(router);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({ status: 'healthy' })
    );
  });

  test('GET /system/health degraded fallback also uses the { success, data } envelope', async () => {
    jest.doMock('../../../services/admin/systemHealth.service', () => ({
      getSystemHealthStatus: jest.fn().mockRejectedValue(new Error('probe failed')),
    }));

    const router = require('../systemHealth.routes');
    const app = buildApp(router);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({ status: 'degraded' })
    );
  });
});
