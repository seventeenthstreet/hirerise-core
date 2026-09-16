'use strict';

/**
 * routes/__tests__/student-onboarding.routes.results.test.js
 *
 * HireRise Student MVP Phase 1 Pass 5 — Results/status contract audit +
 * implementation (spec §11 "Backend" tests 1–8).
 *
 * GET /api/v1/student-onboarding/results previously returned only
 * `{ result: null }` or `{ result, generatedAt, engineVersion }`, with no
 * way to distinguish "no row yet" (not_started) from "row exists but still
 * generating" (pending), and no way to surface a failure state. This suite
 * verifies the redesigned contract:
 *
 *   not_started → { status: 'not_started' }
 *   pending     → { status: 'pending' }
 *   ready       → { status: 'ready', result, generatedAt, engineVersion }
 *   failed      → { status: 'failed', message: <safe text> }
 *
 * Mounts the real router (module under audit) behind a minimal Express app
 * standing in for the `authenticate` mount in server.js, matching the
 * existing student-onboarding.routes.generateRecommendations.test.js
 * convention exactly. Only the Supabase client is mocked.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

jest.mock('../../utils/freshnessCache', () => ({
  del: jest.fn(),
}));

// Chainable Supabase mock: .from(...).select(...).eq(...).maybeSingle()
function buildSupabaseMock(maybeSingleResult) {
  const maybeSingle = jest.fn().mockResolvedValue(maybeSingleResult);
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { from, __eq: eq, __select: select, __maybeSingle: maybeSingle };
}

let mockSupabase;

jest.mock('../../lib/supabaseClient', () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const studentOnboardingRoutes = require('../student-onboarding.routes');

function buildApp({ user = { id: 'user-1' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/v1/student-onboarding', studentOnboardingRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('GET /results — authoritative status/result contract (Phase 1 Pass 5)', () => {
  afterEach(() => jest.clearAllMocks());

  describe('Test 1 — not_started', () => {
    it('returns { status: "not_started" } when no result row exists', async () => {
      mockSupabase = buildSupabaseMock({ data: null, error: null });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { status: 'not_started' } });
    });
  });

  describe('Test 2 — pending', () => {
    it('returns { status: "pending" } and nothing else while generation is in progress', async () => {
      mockSupabase = buildSupabaseMock({
        data: { status: 'pending', error_detail: null, result_json: {}, generated_at: null, engine_version: 'v1' },
        error: null,
      });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { status: 'pending' } });
      // No partial/stale result content ever leaks while pending.
      expect(res.body.data).not.toHaveProperty('result');
    });
  });

  describe('Test 3 — ready', () => {
    it('returns the full result payload with status "ready"', async () => {
      const fakeResult = { strengthSummary: { traits: ['analytical'] }, recommendedDomains: [] };
      mockSupabase = buildSupabaseMock({
        data: {
          status: 'ready',
          error_detail: null,
          result_json: JSON.stringify(fakeResult),
          generated_at: '2026-01-01T00:00:00.000Z',
          engine_version: 'v1',
        },
        error: null,
      });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          status: 'ready',
          result: fakeResult,
          generatedAt: '2026-01-01T00:00:00.000Z',
          engineVersion: 'v1',
        },
      });
    });

    it('handles an already-object result_json (not double-encoded)', async () => {
      const fakeResult = { recommendedDomains: [{ id: 'ai-engineering' }] };
      mockSupabase = buildSupabaseMock({
        data: {
          status: 'ready',
          error_detail: null,
          result_json: fakeResult,
          generated_at: '2026-01-01T00:00:00.000Z',
          engine_version: 'v1',
        },
        error: null,
      });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(200);
      expect(res.body.data.result).toEqual(fakeResult);
    });
  });

  describe('Test 4 — failed, with safe failure information (Test 5: no raw leakage)', () => {
    it('surfaces the safe error_detail under `message`', async () => {
      mockSupabase = buildSupabaseMock({
        data: {
          status: 'failed',
          error_detail: 'Recommendation provider request failed (status 500).',
          result_json: {},
          generated_at: null,
          engine_version: 'v1',
        },
        error: null,
      });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          status: 'failed',
          message: 'Recommendation provider request failed (status 500).',
        },
      });
    });

    it('falls back to a generic safe message when error_detail is empty/null', async () => {
      mockSupabase = buildSupabaseMock({
        data: { status: 'failed', error_detail: null, result_json: {}, generated_at: null, engine_version: 'v1' },
        error: null,
      });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        status: 'failed',
        message: "We couldn't generate your recommendation right now. Please try again.",
      });
    });

    it('never returns a `result` field alongside a failed status', async () => {
      mockSupabase = buildSupabaseMock({
        data: { status: 'failed', error_detail: 'boom', result_json: {}, generated_at: null, engine_version: 'v1' },
        error: null,
      });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.body.data).not.toHaveProperty('result');
    });
  });

  describe('Test 6 — authenticated ownership enforcement', () => {
    it('scopes the query to the authenticated user only', async () => {
      mockSupabase = buildSupabaseMock({ data: null, error: null });
      const app = buildApp({ user: { id: 'authenticated-user-id' } });

      await request(app).get('/api/v1/student-onboarding/results');

      expect(mockSupabase.__eq).toHaveBeenCalledWith('user_id', 'authenticated-user-id');
    });

    it('rejects unauthenticated requests before querying Supabase', async () => {
      mockSupabase = buildSupabaseMock({ data: null, error: null });
      const app = buildApp({ user: null });

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(401);
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });
  });

  describe('Test 7 — missing-row behavior', () => {
    it('a maybeSingle() null data (no matching row) is not_started, not a 500', async () => {
      mockSupabase = buildSupabaseMock({ data: null, error: null });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('not_started');
    });
  });

  describe('database error handling', () => {
    it('surfaces a 500 without leaking Supabase error internals into the body', async () => {
      mockSupabase = buildSupabaseMock({
        data: null,
        error: { message: 'connection reset', code: 'XX000' },
      });
      const app = buildApp();

      const res = await request(app).get('/api/v1/student-onboarding/results');

      expect(res.status).toBe(500);
    });
  });
});
