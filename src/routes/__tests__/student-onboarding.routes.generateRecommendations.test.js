'use strict';

/**
 * routes/__tests__/student-onboarding.routes.generateRecommendations.test.js
 *
 * HireRise Student MVP Phase 1 Pass 4 — legacy `/generate-recommendations`
 * bypass audit and containment (spec §11/§12/§16 Tests G, H).
 *
 * Audit finding: this legacy, orphaned-but-still-mounted route previously
 * called recommendation-engine.js#generateRecommendations() DIRECTLY,
 * bypassing the atomic duplicate-guard in initiateGeneration() — meaning
 * repeated calls could fire concurrent/racing AI provider calls with no
 * dedup, no CreditGuard, no rate limit, no quota. This suite verifies the
 * containment: the route now delegates to the SAME guarded
 * initiateGeneration() entry point used by the backend-owned
 * aspiration -> processing trigger, and that identity is always taken from
 * the authenticated request, never from the client body.
 *
 * Mounts the real router (module under audit) behind a minimal Express app
 * standing in for the `authenticate` mount in server.js. Only the Supabase
 * client and the lazily-required recommendation-engine module are mocked.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../lib/supabaseClient', () => ({}));

jest.mock('../../utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const mockInitiateGeneration = jest.fn();
const mockGenerateRecommendations = jest.fn();

jest.mock('../../modules/student-onboarding/services/recommendation-engine', () => ({
  initiateGeneration: (...args) => mockInitiateGeneration(...args),
  generateRecommendations: (...args) => mockGenerateRecommendations(...args),
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

describe('POST /generate-recommendations — legacy route containment (Phase 1 Pass 4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInitiateGeneration.mockResolvedValue({ started: true });
  });

  describe('Test G — legacy route cannot bypass the lifecycle guard', () => {
    it('delegates to initiateGeneration() — the same guarded lifecycle entry point — not generateRecommendations() directly', async () => {
      const app = buildApp();

      const res = await request(app)
        .post('/api/v1/student-onboarding/generate-recommendations')
        .send({});

      expect(res.status).toBe(202);
      expect(mockInitiateGeneration).toHaveBeenCalledTimes(1);
      expect(mockInitiateGeneration).toHaveBeenCalledWith('user-1');
      // The raw, unguarded entry point must never be called directly by
      // this route — that was the exact bypass this pass closes.
      expect(mockGenerateRecommendations).not.toHaveBeenCalled();
    });

    it('a second call while generation is already in flight is a safe no-op (no duplicate/racing generation)', async () => {
      // initiateGeneration()'s own conditional upsert is what enforces
      // this — simulate its "already initiated" result.
      mockInitiateGeneration.mockResolvedValue({ started: false });

      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/student-onboarding/generate-recommendations')
        .send({});

      // Response contract is unchanged regardless of started/not-started —
      // this route never inspected that flag, before or after this pass.
      expect(res.status).toBe(202);
      expect(mockInitiateGeneration).toHaveBeenCalledTimes(1);
      expect(mockGenerateRecommendations).not.toHaveBeenCalled();
    });
  });

  describe('Test H — identity/ownership: no client-supplied user id can be used', () => {
    it('userId always comes from the authenticated request, never from req.body', async () => {
      const app = buildApp({ user: { id: 'authenticated-user' } });

      await request(app)
        .post('/api/v1/student-onboarding/generate-recommendations')
        .send({ userId: 'someone-elses-id', user_id: 'also-someone-elses-id' });

      expect(mockInitiateGeneration).toHaveBeenCalledWith('authenticated-user');
    });

    it('unauthenticated requests are rejected before initiateGeneration() is ever called', async () => {
      const app = buildApp({ user: null });

      const res = await request(app)
        .post('/api/v1/student-onboarding/generate-recommendations')
        .send({});

      expect(res.status).toBe(401);
      expect(mockInitiateGeneration).not.toHaveBeenCalled();
    });
  });

  describe('non-blocking / response contract', () => {
    it('returns 202 without waiting for AI generation to complete', async () => {
      // initiateGeneration() itself resolves quickly (its own atomic
      // upsert), never blocking on generateRecommendations()/provider
      // latency — confirmed by resolving immediately here.
      mockInitiateGeneration.mockResolvedValue({ started: true });

      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/student-onboarding/generate-recommendations')
        .send({});

      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        success: true,
        data: { message: 'Recommendation generation started. Poll GET /results for completion.' },
      });
    });

    it('a failure inside initiateGeneration() is logged and swallowed — the request still succeeds', async () => {
      mockInitiateGeneration.mockRejectedValue(new Error('db unavailable'));

      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/student-onboarding/generate-recommendations')
        .send({});

      expect(res.status).toBe(202);
      expect(mockInitiateGeneration).toHaveBeenCalledWith('user-1');
    });
  });
});
