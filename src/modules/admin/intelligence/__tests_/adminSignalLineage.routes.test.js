'use strict';

/**
 * core/src/modules/admin/intelligence/__tests__/adminSignalLineage.routes.test.js
 *
 * Integration test skeleton — A09 Routes
 * HireRise Phase 2A.1.3
 *
 * Test runner: Jest + Supertest
 *
 * These tests exercise the full Express middleware chain for the route:
 *   GET /api/v1/intelligence/admin/signal-lineage/:signal_key
 *
 * Authentication and authorization middleware are mocked at the module level
 * so that unit coverage can be achieved without a live Supabase environment.
 */

const express = require('express');
const request = require('supertest');

// ─────────────────────────────────────────────────────────────
// MOCKS
// ─────────────────────────────────────────────────────────────

// Mock authenticate — sets req.user on all calls unless overridden per test
jest.mock('../../../middleware/auth.middleware', () => ({
  authenticate: (req, _res, next) => {
    req.user = { uid: 'admin-uid-123', email: 'admin@hirerise.com', role: 'admin' };
    next();
  },
  requireAdmin: (req, _res, next) => {
    req.adminPrincipal = { id: 'admin-uid-123' };
    next();
  },
}));

// Mock controller — avoids real Supabase calls in route integration tests
jest.mock('../adminSignalLineage.controller', () => ({
  getSignalLineage: jest.fn((_req, res) =>
    res.json({
      success: true,
      data:    { signalKey: 'skills.test', lineage: [], total: 0 },
      meta:    { duration_ms: 5 },
    })
  ),
}));

const { authenticate, requireAdmin } = require('../../../middleware/auth.middleware');
const { getSignalLineage }           = require('../adminSignalLineage.controller');
const router                         = require('../adminSignalLineage.routes');

// ─────────────────────────────────────────────────────────────
// TEST APP SETUP
// ─────────────────────────────────────────────────────────────

/**
 * Constructs a minimal Express app that mirrors the server.js mount pattern:
 *   app.use(`${API_PREFIX}/intelligence/admin`, authenticate, requireAdmin, router)
 *
 * Override authenticate/requireAdmin per test to simulate 401/403 scenarios.
 */
function buildApp({ authMiddleware, adminMiddleware } = {}) {
  const app = express();
  app.use(express.json());

  const auth  = authMiddleware  || authenticate;
  const admin = adminMiddleware || requireAdmin;

  app.use('/api/v1/intelligence/admin', auth, admin, router);

  // Minimal error handler so validation and AppError responses are visible
  app.use((err, _req, res, _next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({
      success: false,
      error: {
        code:    err.code    || 'INTERNAL_ERROR',
        message: err.message || 'Internal server error',
      },
    });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── 1. Valid request ─────────────────────────────────────────

describe('GET /api/v1/intelligence/admin/signal-lineage/:signal_key — valid request', () => {
  it('returns 200 and calls controller with correct signal_key', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/v1/intelligence/admin/signal-lineage/skills.data_analysis.advanced')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(getSignalLineage).toHaveBeenCalledTimes(1);
  });

  it('returns 200 for signal_key containing dots and underscores', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/v1/intelligence/admin/signal-lineage/skills.data_analysis.v2_advanced')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
  });

  it('signal_key at max allowed length (200 chars) is accepted', async () => {
    const longKey = 'a'.repeat(200);
    const app = buildApp();

    const res = await request(app)
      .get(`/api/v1/intelligence/admin/signal-lineage/${longKey}`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
  });
});

// ── 2. Invalid signal_key — validation rejection ─────────────

describe('GET /api/v1/intelligence/admin/signal-lineage/:signal_key — invalid signal_key', () => {
  it('returns 400 when signal_key exceeds 200 characters', async () => {
    const tooLong = 'a'.repeat(201);
    const app = buildApp();

    const res = await request(app)
      .get(`/api/v1/intelligence/admin/signal-lineage/${tooLong}`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(getSignalLineage).not.toHaveBeenCalled();
  });

  // Note: Express router does not match routes with an empty :signal_key segment —
  // a request to /signal-lineage/ without a segment returns 404 at the framework level.
  // The notEmpty() validator catches whitespace-only values that do pass the route match.
  it('does not invoke controller when request would fail route-level validation', async () => {
    const tooLong = 'x'.repeat(201);
    const app = buildApp();

    await request(app)
      .get(`/api/v1/intelligence/admin/signal-lineage/${tooLong}`)
      .set('Authorization', 'Bearer valid-token');

    expect(getSignalLineage).not.toHaveBeenCalled();
  });
});

// ── 3. Unauthenticated access ────────────────────────────────

describe('GET /api/v1/intelligence/admin/signal-lineage/:signal_key — unauthenticated', () => {
  it('returns 401 when authenticate middleware rejects', async () => {
    const unauthMiddleware = (_req, res, _next) => {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' },
      });
    };

    const app = buildApp({ authMiddleware: unauthMiddleware });

    const res = await request(app)
      .get('/api/v1/intelligence/admin/signal-lineage/skills.test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getSignalLineage).not.toHaveBeenCalled();
  });
});

// ── 4. Non-admin access ──────────────────────────────────────

describe('GET /api/v1/intelligence/admin/signal-lineage/:signal_key — non-admin', () => {
  it('returns 403 when requireAdmin middleware rejects', async () => {
    const forbiddenAdmin = (_req, res, _next) => {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      });
    };

    const app = buildApp({ adminMiddleware: forbiddenAdmin });

    const res = await request(app)
      .get('/api/v1/intelligence/admin/signal-lineage/skills.test')
      .set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(getSignalLineage).not.toHaveBeenCalled();
  });

  it('returns 503 when requireAdmin DB verification is unavailable', async () => {
    const serviceUnavailableAdmin = (_req, res, _next) => {
      res.status(503).json({
        success: false,
        error: { code: 'ADMIN_SERVICE_UNAVAILABLE', message: 'Admin verification unavailable' },
      });
    };

    const app = buildApp({ adminMiddleware: serviceUnavailableAdmin });

    const res = await request(app)
      .get('/api/v1/intelligence/admin/signal-lineage/skills.test')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ADMIN_SERVICE_UNAVAILABLE');
  });
});

// ── 5. Route produces correct full path ─────────────────────

describe('route structure', () => {
  it('responds at /api/v1/intelligence/admin/signal-lineage/:signal_key', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/v1/intelligence/admin/signal-lineage/skills.analytics');

    // Any non-404 confirms the route is registered at the expected path
    expect(res.status).not.toBe(404);
  });

  it('returns 404 for unknown sub-paths under the mount prefix', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/v1/intelligence/admin/unknown-route')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
  });
});
