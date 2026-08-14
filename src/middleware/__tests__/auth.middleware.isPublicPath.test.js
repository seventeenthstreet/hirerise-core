'use strict';

/**
 * auth.middleware.isPublicPath.test.js — WP-DIAG mount-collision bugfix
 *
 * Regression coverage for the bug where authenticated admin sub-routes
 * whose last path segment happened to match a top-level public infra path
 * (/health, /metrics, /ready, /webhooks*, /internal/*) were silently
 * treated as public and skipped JWT verification entirely.
 *
 * Root cause: `authenticate` is mounted per-route throughout server.js
 * (e.g. `app.use('/api/v1/admin/graph', authenticate, ...)`). Express
 * strips the matched mount prefix from req.path before calling per-route
 * middleware, so a request to GET /api/v1/admin/graph/health arrived at
 * isPublicPath() as bare '/health' — an exact match against the public
 * allowlist meant for the real load-balancer health check. `authenticate`
 * then called next() without ever verifying the JWT or setting req.user,
 * and the downstream requireAdmin middleware correctly rejected the
 * now-unauthenticated request with 401 UNAUTHORIZED.
 *
 * The fix: isPublicPath must be called with req.originalUrl (unaffected
 * by mount-stripping) rather than req.path, so matching is always against
 * the full path from the true app root.
 */

jest.mock('../../config/supabase', () => ({
  supabase: { from: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { isPublicPath } = require('../auth.middleware');

describe('auth.middleware — isPublicPath', () => {
  describe('real public infra endpoints still match', () => {
    it.each([
      '/api/v1/health',
      '/api/v1/health/deep',
      '/api/v1/ready',
      '/api/v1/metrics',
      '/api/v1/webhooks',
      '/api/v1/webhooks/stripe',
      '/api/v1/internal/ai-job',
    ])('%s is public', (url) => {
      expect(isPublicPath(url)).toBe(true);
    });

    it('strips the query string before matching', () => {
      expect(isPublicPath('/api/v1/health?probe=1')).toBe(true);
    });
  });

  describe('THE REGRESSION — same-named sub-routes on non-public mounts must NOT match', () => {
    it.each([
      '/api/v1/admin/graph/health',
      '/api/v1/admin/graph/metrics',
      '/api/v1/admin/graph-intelligence/health',
      '/api/v1/admin/systemHealth/health',
    ])('%s is NOT public', (url) => {
      expect(isPublicPath(url)).toBe(false);
    });
  });

  describe('unrelated authenticated routes', () => {
    it.each([
      '/api/v1/admin/graph/validate',
      '/api/v1/admin/graph/dataset-statuses',
      '/api/v1/users/me',
    ])('%s is NOT public', (url) => {
      expect(isPublicPath(url)).toBe(false);
    });
  });
});
